import { createDb, type Database } from '@awah/db'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import Redis from 'ioredis'
import { authPlugin } from './auth/plugin'
import { dashboardPlugin, isServerRoute } from './dashboard/plugin'
import { demoPlugin } from './demo/plugin'
import type { Env } from './env'
import { AppError } from './lib/errors'
import { authRoutes } from './modules/auth/routes'
import { healthRoutes } from './modules/health/routes'
import { integrationRoutes } from './modules/integrations/routes'
import { apiKeyRoutes } from './modules/keys/routes'
import { messageRoutes } from './modules/messages/routes'
import { metaRoutes } from './modules/meta/routes'
import { metricsRoutes } from './modules/metrics/routes'
import { orgRoutes } from './modules/orgs/routes'
import { riskRoutes } from './modules/risk/routes'
import { sessionRoutes } from './modules/sessions/routes'
import { webhookRoutes } from './modules/webhooks/routes'
import { sessionsPlugin } from './sessions/plugin'
import { telemetryPlugin } from './telemetry/plugin'
import { workersPlugin } from './workers/plugin'

declare module 'fastify' {
  interface FastifyInstance {
    env: Env
    db: Database
    redis: Redis
  }
  interface FastifyRequest {
    /** The body's original bytes. Only filled in on Meta's callbacks. */
    rawBody?: Buffer
  }
}

/** Not every error the handler sees is a FastifyError — hence the narrowing. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    return typeof value === 'number' ? value : undefined
  }
  return undefined
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    /**
     * Comes from the environment and is `false` by default.
     *
     * Trusting `X-Forwarded-For` with no proxy in front is not convenience, it
     * is a hole: the per-IP rate limit uses `request.ip`, and a client that
     * picks its own IP through the header changes the value on every request
     * and never hits the limit. Behind a proxy, prefer the CIDR list to blanket
     * trust.
     */
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT_BYTES,
    // The gateway often sits behind a proxy; ids of our own would break the trail.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  /**
   * Keeps the raw body of Meta's callbacks.
   *
   * The `X-Hub-Signature-256` signature covers the exact bytes they sent;
   * re-serializing the already-parsed object produces similar bytes, not
   * identical ones, and the HMAC would fail intermittently. The buffer is only
   * kept on these routes — doing it for all traffic would cost memory in
   * exchange for nothing.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (request.url.startsWith('/webhooks/meta/')) {
        request.rawBody = body
      }

      if (body.length === 0) return done(null, undefined)

      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (error) {
        done(error as Error, undefined)
      }
    },
  )

  const database = createDb({
    url: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    debug: env.NODE_ENV === 'development' && env.LOG_LEVEL === 'trace',
  })

  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  })
  redis.on('error', (error) => {
    app.log.error({ err: error }, 'Redis error')
  })

  app.decorate('env', env)
  app.decorate('db', database.db)
  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    await Promise.allSettled([database.close(), redis.quit()])
  })

  /**
   * Hand-written CSP, and on in both environments.
   *
   * Helmet's default policy would break three concrete things in this panel:
   * the QR arrives as a `data:` URI, the components position bars through the
   * `style` attribute, and Swagger UI builds its own inline stylesheet. Leaving
   * the CSP to production only — as it was — means nobody finds the breakage
   * until deploy. Here it holds from `pnpm dev` on, with the three exceptions
   * named.
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        // Swagger UI injects its own style; the panel positions bars by attribute.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // `data:` is the pairing QR, which comes embedded in the API's response.
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        // Own origin only: the panel never talks to another server.
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
      },
    },
  })
  await app.register(cookie, { secret: env.COOKIE_SECRET })
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis,
    // The API key is the limit's subject when there is one; otherwise the IP.
    keyGenerator: (request) => {
      const header = request.headers.authorization
      return header ? `k:${header.slice(-24)}` : `i:${request.ip}`
    },
  })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AWAH',
        description: 'WhatsApp gateway with a durable queue, risk engine and clustered sessions.',
        version: '0.1.0',
      },
      servers: [{ url: env.PUBLIC_URL ?? `http://localhost:${env.PORT}` }],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'API key in the format `awah_<prefix>_<secret>`.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  await app.register(dashboardPlugin)
  await app.register(authPlugin)
  await app.register(sessionsPlugin)
  await app.register(telemetryPlugin)
  await app.register(workersPlugin)
  // A no-op unless DEMO_MODE is on, and it decorates `app.demo` either way.
  await app.register(demoPlugin)

  /**
   * One error shape for the whole API. Clients branch on `error.code`, so it
   * is public contract — messages may change, codes may not.
   *
   * It has to come BEFORE the routes are registered: each `register` opens a
   * plugin context that inherits whatever error handler is in force the moment
   * it is created. Setting the handler afterwards leaves the routes stuck with
   * Fastify's default, and the documented error shape silently stops holding.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request failed validation.',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        },
      })
    }

    const statusCode = statusCodeOf(error)

    if (statusCode === 429) {
      return reply.code(429).send({
        error: {
          code: 'too_many_requests',
          message: 'Too many requests. Try again shortly.',
        },
      })
    }

    /**
     * A client's error is a warning; ours is an error.
     *
     * Body too large, malformed JSON and the like arrive here as 4xx. Logging
     * each one as "unhandled error" fills the log with things that are not the
     * server's problem — and drowns the things that are.
     */
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err: error }, 'request rejected')
      return reply.code(statusCode).send({
        error: { code: 'bad_request', message: 'Invalid request.' },
      })
    }

    // Unforeseen error: log the detail, return the generic one.
    request.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal error.' },
    })
  })

  /**
   * A 404 with two destinations.
   *
   * Browser navigation to an unknown path gets the dashboard's HTML — that is
   * how client-side routing works. Anything else gets the same JSON error
   * envelope as always, including a GET to a `/v1/` route that does not exist:
   * returning HTML there would cost an integrator an afternoon working out why
   * the JSON turned into `<!doctype html>`.
   */
  app.setNotFoundHandler((request, reply) => {
    const navigation =
      app.spaIndex !== null &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !isServerRoute(request.url) &&
      String(request.headers.accept ?? '').includes('text/html')

    if (navigation) {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(app.spaIndex)
    }

    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: `Route does not exist: ${request.method} ${request.url}`,
      },
    })
  })

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(orgRoutes)
  await app.register(apiKeyRoutes)
  await app.register(sessionRoutes)
  await app.register(messageRoutes)
  await app.register(webhookRoutes)
  await app.register(riskRoutes)
  await app.register(metricsRoutes)
  await app.register(metaRoutes)
  await app.register(integrationRoutes)

  return app
}
