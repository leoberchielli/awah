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
import { dashboardPlugin, ehRotaDoServidor } from './dashboard/plugin'
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
    /** Bytes originais do corpo. Só preenchido nos callbacks da Meta. */
    rawBody?: Buffer
  }
}

/** Nem todo erro que chega ao handler é um FastifyError — daí o narrowing. */
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
     * Vem do ambiente e é `false` por padrão.
     *
     * Confiar em `X-Forwarded-For` sem ter proxy na frente não é conveniência, é
     * um buraco: o rate limit por IP usa `request.ip`, e um cliente que escolhe o
     * próprio IP pelo cabeçalho troca de valor a cada requisição e nunca bate no
     * limite. Atrás de proxy, prefira a lista de CIDRs à confiança irrestrita.
     */
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT_BYTES,
    // O gateway fica atrás de proxy com frequência; ids próprios atrapalham o rastro.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  /**
   * Preserva o corpo cru dos callbacks da Meta.
   *
   * A assinatura `X-Hub-Signature-256` cobre os bytes exatos que eles enviaram;
   * reserializar o objeto já parseado produz bytes parecidos, não idênticos, e o
   * HMAC falharia de forma intermitente. O buffer só é guardado nessas rotas —
   * fazer isso para todo o tráfego custaria memória em troca de nada.
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
    app.log.error({ err: error }, 'erro no Redis')
  })

  app.decorate('env', env)
  app.decorate('db', database.db)
  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    await Promise.allSettled([database.close(), redis.quit()])
  })

  /**
   * CSP escrita à mão, e ligada nos dois ambientes.
   *
   * A política padrão do helmet quebraria três coisas concretas deste painel: o
   * QR chega como `data:` URI, os componentes posicionam barras por atributo
   * `style`, e o Swagger UI monta a própria folha inline. Deixar a CSP só para
   * produção — como estava — significa que ninguém descobre a quebra até o
   * deploy. Aqui ela vale desde o `pnpm dev`, com as três exceções nomeadas.
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        // O Swagger UI injeta estilo próprio; o painel posiciona barras por atributo.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // `data:` é o QR de pareamento, que vem embutido na resposta da API.
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        // Só a própria origem: o painel nunca fala com outro servidor.
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
    // Chave de API é o sujeito do limite quando existe; senão, o IP.
    keyGenerator: (request) => {
      const header = request.headers.authorization
      return header ? `k:${header.slice(-24)}` : `i:${request.ip}`
    },
  })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AWAH',
        description: 'Gateway de WhatsApp com fila durável, motor de risco e sessões em cluster.',
        version: '0.1.0',
      },
      servers: [{ url: env.PUBLIC_URL ?? `http://localhost:${env.PORT}` }],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'Chave de API no formato `awah_<prefixo>_<segredo>`.',
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

  /**
   * Formato de erro único para toda a API. Clientes fazem branch em
   * `error.code`, então ele é contrato público — mensagens podem mudar, códigos
   * não.
   *
   * Precisa vir ANTES do register das rotas: cada `register` abre um contexto de
   * plugin que herda o error handler vigente no momento em que é criado. Definir
   * o handler depois deixa as rotas presas ao padrão do Fastify, e o formato de
   * erro documentado deixa silenciosamente de valer.
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
          message: 'A requisição não passou na validação.',
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
          message: 'Requisições demais. Tente de novo em instantes.',
        },
      })
    }

    // Erro não previsto: registra o detalhe, devolve o genérico.
    request.log.error({ err: error }, 'erro não tratado')
    return reply.code(statusCode && statusCode < 500 ? statusCode : 500).send({
      error: { code: 'internal_error', message: 'Erro interno.' },
    })
  })

  /**
   * 404 com dois destinos.
   *
   * Navegação de navegador para um caminho desconhecido recebe o HTML do
   * dashboard — é assim que rota de cliente funciona. Qualquer outra coisa
   * recebe o mesmo envelope de erro em JSON de sempre, inclusive um GET a
   * `/v1/` inexistente: devolver HTML ali faria quem integra passar a tarde
   * tentando entender por que o JSON virou `<!doctype html>`.
   */
  app.setNotFoundHandler((request, reply) => {
    const navegacao =
      app.spaIndex !== null &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !ehRotaDoServidor(request.url) &&
      String(request.headers.accept ?? '').includes('text/html')

    if (navegacao) {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(app.spaIndex)
    }

    return reply.code(404).send({
      error: { code: 'not_found', message: `Rota não existe: ${request.method} ${request.url}` },
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
