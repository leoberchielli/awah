import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { findDashboard, isServerRoute } from '../../src/dashboard/plugin'
import { loadEnv } from '../../src/env'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const HTML =
  '<!doctype html><html><head><title>AWAH</title></head><body><div id="root"></div></body></html>'

/** A fake build, with the same shape as the real one. */
function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'awah-dash-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), HTML)
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("awah")')
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return root
}

describe('split between server routes and dashboard routes', () => {
  it('recognises what belongs to the API', () => {
    expect(isServerRoute('/v1/sessions')).toBe(true)
    expect(isServerRoute('/v1/kpi/delivery?hours=24')).toBe(true)
    expect(isServerRoute('/webhooks/meta/abc')).toBe(true)
    expect(isServerRoute('/metrics')).toBe(true)
    expect(isServerRoute('/docs')).toBe(true)
  })

  it('lets through what belongs to the dashboard', () => {
    expect(isServerRoute('/operacao')).toBe(false)
    expect(isServerRoute('/sessions?hours=168')).toBe(false)
    expect(isServerRoute('/signin')).toBe(false)
    // A path that merely *starts* alike is not a server route.
    expect(isServerRoute('/v1negocio')).toBe(false)
  })

  it('finds no dashboard where there is no build', () => {
    expect(findDashboard(mkdtempSync(join(tmpdir(), 'awah-vazio-')))).toBeNull()
  })
})

describe.skipIf(!hasInfra)('SPA served by the API', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ ...loadEnv(), DASHBOARD_DIR: makeDist() })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  const browser = { accept: 'text/html,application/xhtml+xml' }

  it('serves the HTML on a client route', async () => {
    const response = await app.inject({ method: 'GET', url: '/operacao', headers: browser })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('<div id="root">')
  })

  it('serves the static files', async () => {
    const script = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(script.statusCode).toBe(200)
    expect(script.headers['cache-control']).toContain('immutable')

    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['cache-control']).toBe('no-cache')
  })

  /**
   * The bug this test exists to prevent: a typo in an API route returning the
   * HTML page with status 200, and whoever is integrating trying to work out
   * why their JSON turned into `<!doctype html>`.
   */
  it('does not return HTML for a nonexistent API route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessoes',
      headers: { ...browser, authorization: 'Bearer awah_naoexiste_naoexiste' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toHaveProperty('error.code', 'not_found')
  })

  it('does not return HTML to whoever asked for JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/operacao',
      headers: { accept: 'application/json' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toHaveProperty('error.code', 'not_found')
  })

  it('does not return HTML for a method that is not navigation', async () => {
    const response = await app.inject({ method: 'POST', url: '/operacao', headers: browser })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toHaveProperty('error.code', 'not_found')
  })

  it('the API routes keep answering what they always answered', async () => {
    const withoutCredential = await app.inject({ method: 'GET', url: '/v1/sessions' })
    expect(withoutCredential.statusCode).toBe(401)
    expect(withoutCredential.json()).toHaveProperty('error.code')

    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
  })

  it('the Meta webhook is not swallowed by the SPA', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/meta/00000000-0000-0000-0000-000000000000?hub.mode=subscribe',
      headers: browser,
    })

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('application/json')
  })
})
