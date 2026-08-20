import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { ehRotaDoServidor, encontrarDashboard } from '../../src/dashboard/plugin'
import { loadEnv } from '../../src/env'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const HTML =
  '<!doctype html><html><head><title>AWAH</title></head><body><div id="root"></div></body></html>'

/** A fake build, with the same shape as the real one. */
function montarDist(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'awah-dash-'))
  mkdirSync(join(raiz, 'assets'))
  writeFileSync(join(raiz, 'index.html'), HTML)
  writeFileSync(join(raiz, 'assets', 'index-abc123.js'), 'console.log("awah")')
  writeFileSync(join(raiz, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return raiz
}

describe('separação entre rotas do servidor e do dashboard', () => {
  it('reconhece o que pertence à API', () => {
    expect(ehRotaDoServidor('/v1/sessions')).toBe(true)
    expect(ehRotaDoServidor('/v1/kpi/delivery?hours=24')).toBe(true)
    expect(ehRotaDoServidor('/webhooks/meta/abc')).toBe(true)
    expect(ehRotaDoServidor('/metrics')).toBe(true)
    expect(ehRotaDoServidor('/docs')).toBe(true)
  })

  it('deixa passar o que pertence ao dashboard', () => {
    expect(ehRotaDoServidor('/operacao')).toBe(false)
    expect(ehRotaDoServidor('/sessoes?horas=168')).toBe(false)
    expect(ehRotaDoServidor('/entrar')).toBe(false)
    // A path that merely *starts* alike is not a server route.
    expect(ehRotaDoServidor('/v1negocio')).toBe(false)
  })

  it('não encontra dashboard onde não há build', () => {
    expect(encontrarDashboard(mkdtempSync(join(tmpdir(), 'awah-vazio-')))).toBeNull()
  })
})

describe.skipIf(!hasInfra)('SPA servida pela API', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ ...loadEnv(), DASHBOARD_DIR: montarDist() })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  const navegador = { accept: 'text/html,application/xhtml+xml' }

  it('entrega o HTML numa rota de cliente', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/operacao', headers: navegador })

    expect(resposta.statusCode).toBe(200)
    expect(resposta.headers['content-type']).toContain('text/html')
    expect(resposta.body).toContain('<div id="root">')
  })

  it('entrega os arquivos estáticos', async () => {
    const script = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(script.statusCode).toBe(200)
    expect(script.headers['cache-control']).toContain('immutable')

    const icone = await app.inject({ method: 'GET', url: '/favicon.svg' })
    expect(icone.statusCode).toBe(200)
    expect(icone.headers['cache-control']).toBe('no-cache')
  })

  /**
   * The bug this test exists to prevent: a typo in an API route returning the
   * HTML page with status 200, and whoever is integrating trying to work out
   * why their JSON turned into `<!doctype html>`.
   */
  it('não devolve HTML para rota de API inexistente', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/v1/sessoes',
      headers: { ...navegador, authorization: 'Bearer awah_naoexiste_naoexiste' },
    })

    expect(resposta.statusCode).toBe(404)
    expect(resposta.json()).toHaveProperty('error.code', 'not_found')
  })

  it('não devolve HTML para quem pediu JSON', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/operacao',
      headers: { accept: 'application/json' },
    })

    expect(resposta.statusCode).toBe(404)
    expect(resposta.json()).toHaveProperty('error.code', 'not_found')
  })

  it('não devolve HTML para método que não é navegação', async () => {
    const resposta = await app.inject({ method: 'POST', url: '/operacao', headers: navegador })

    expect(resposta.statusCode).toBe(404)
    expect(resposta.json()).toHaveProperty('error.code', 'not_found')
  })

  it('as rotas da API continuam respondendo o que sempre responderam', async () => {
    const semCredencial = await app.inject({ method: 'GET', url: '/v1/sessions' })
    expect(semCredencial.statusCode).toBe(401)
    expect(semCredencial.json()).toHaveProperty('error.code')

    const saude = await app.inject({ method: 'GET', url: '/health' })
    expect(saude.statusCode).toBe(200)
  })

  it('o webhook da Meta não é engolido pela SPA', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/webhooks/meta/00000000-0000-0000-0000-000000000000?hub.mode=subscribe',
      headers: navegador,
    })

    expect(resposta.statusCode).toBe(404)
    expect(resposta.headers['content-type']).toContain('application/json')
  })
})
