import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadEnv } from '../src/env'

const hasInfra = Boolean(process.env.DATABASE_URL)

/**
 * `/docs` is served by @fastify/swagger-ui, which carries its own copy of
 * @fastify/static. A vulnerable copy once reached production through that
 * transitive path, and nothing exercised the route, so the upgrade that
 * removed it had no test to answer to. This is that test.
 */
describe.skipIf(!hasInfra)('/docs', () => {
  it('serves the UI and the OpenAPI document', async () => {
    const app = await buildApp(loadEnv())
    try {
      const ui = await app.inject({ method: 'GET', url: '/docs' })
      expect(ui.statusCode).toBe(200)
      expect(ui.headers['content-type']).toContain('text/html')

      const json = await app.inject({ method: 'GET', url: '/docs/json' })
      expect(json.statusCode).toBe(200)
      expect(JSON.parse(json.body).openapi).toBeTruthy()
    } finally {
      await app.close()
    }
  })
})
