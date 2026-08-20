import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    /** The dashboard HTML, or null when it was not bundled into this image. */
    spaIndex: string | null
  }
}

/**
 * Prefixes that belong to the server, not to the dashboard.
 *
 * The SPA answers any path it does not know — that is how client-side routing
 * works. Without this list, a mistyped `GET /v1/session` would return the HTML
 * page with status 200, and the integrator would spend the afternoon working
 * out why the JSON turned into `<!doctype html>`.
 */
const RESERVED_PREFIXES = ['/v1/', '/webhooks/', '/metrics', '/docs', '/health', '/ready']

export function isServerRoute(url: string): boolean {
  const path = url.split('?')[0] ?? url
  return RESERVED_PREFIXES.some((prefixo) =>
    prefixo.endsWith('/') ? path.startsWith(prefixo) : path === prefixo,
  )
}

/**
 * Finds where the dashboard files are.
 *
 * Three real scenarios, and none of them follows from the others: the Docker
 * image copies the build into `public`, next to the bundle; the monorepo in
 * development has `apps/web/dist`; and anyone who packages it some other way
 * points DASHBOARD_DIR at it. That is the order — explicit beats convention.
 */
export function findDashboard(dirExplicito?: string): string | null {
  const candidates = dirExplicito
    ? [isAbsolute(dirExplicito) ? dirExplicito : resolve(process.cwd(), dirExplicito)]
    : [
        resolve(process.cwd(), 'public'),
        resolve(process.cwd(), 'apps/api/public'),
        resolve(process.cwd(), '../web/dist'),
        resolve(process.cwd(), 'apps/web/dist'),
      ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }

  return null
}

/**
 * Serves the dashboard from the same origin as the API.
 *
 * Same origin is not a packaging detail: it is what lets the panel's credential
 * be an `httpOnly` cookie instead of a token in `localStorage`. On separate
 * origins the browser would demand `SameSite=None`, and then the cookie starts
 * riding along on third-party requests — exactly what it was there to prevent.
 *
 * The 404 is not handled here: the single handler in `app.ts` still answers it,
 * by consulting `spaIndex`. Fastify refuses two 404 handlers in the same
 * context, and more important — the API's error format is a public contract and
 * needs one owner.
 */
export const dashboardPlugin = fp(async (app: FastifyInstance) => {
  const root = findDashboard(app.env.DASHBOARD_DIR)

  if (!root) {
    app.decorate('spaIndex', null)
    app.log.info(
      'dashboard not bundled; the API starts with the HTTP routes only (`pnpm --filter @awah/web build` generates the files)',
    )
    return
  }

  await app.register(fastifyStatic, {
    root: root,
    prefix: '/',
    /**
     * No wildcard route: the plugin scans the folder at boot and registers one
     * route per file. That way no `GET /*` sits in front of the API routes, and
     * anything that is not a file lands cleanly on the 404 handler.
     */
    wildcard: false,
    index: false,
    setHeaders(response, path) {
      /**
       * The files under `assets/` carry a content hash in the name: content
       * changed, name changed. They can be cached forever. `index.html` has no
       * hash, and it is precisely the file that points at the new names —
       * caching it would leave the browser stuck on the previous version after
       * a deploy.
       */
      if (path.includes(`${sep}assets${sep}`)) {
        response.header('cache-control', 'public, max-age=31536000, immutable')
      } else {
        response.header('cache-control', 'no-cache')
      }
    },
  })

  app.decorate('spaIndex', await readFile(join(root, 'index.html'), 'utf8'))
  app.log.info({ root: root }, 'dashboard served by the API')
})
