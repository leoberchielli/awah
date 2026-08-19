import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env'

const valid = {
  DATABASE_URL: 'postgres://awah:awah@localhost:5432/awah',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  COOKIE_SECRET: randomBytes(48).toString('base64'),
}

describe('validação de ambiente', () => {
  it('aceita a configuração mínima e aplica os defaults', () => {
    const env = loadEnv(valid)
    expect(env.PORT).toBe(2900)
    expect(env.NODE_ENV).toBe('development')
    expect(env.SESSION_TTL_HOURS).toBe(168)
    expect(env.ALLOW_OPEN_REGISTRATION).toBe(false)
  })

  it('deriva NODE_ID do hostname quando não é informado', () => {
    expect(loadEnv(valid).NODE_ID).toBe(hostname())
    expect(loadEnv({ ...valid, NODE_ID: 'awah-3' }).NODE_ID).toBe('awah-3')
  })

  it('exige chave de cifra de exatamente 32 bytes', () => {
    expect(() => loadEnv({ ...valid, ENCRYPTION_KEY: 'curta-demais' })).toThrow('ENCRYPTION_KEY')
    expect(() => loadEnv({ ...valid, ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(
      'ENCRYPTION_KEY',
    )
    expect(() => loadEnv({ ...valid, ENCRYPTION_KEY: randomBytes(64).toString('base64') })).toThrow(
      'ENCRYPTION_KEY',
    )
  })

  it('exige segredo de cookie longo', () => {
    expect(() => loadEnv({ ...valid, COOKIE_SECRET: 'curto' })).toThrow('COOKIE_SECRET')
  })

  it('reclama de dependência ausente', () => {
    const { DATABASE_URL: _omitido, ...semBanco } = valid
    expect(() => loadEnv(semBanco)).toThrow('DATABASE_URL')
  })

  /**
   * `z.coerce.boolean()` trataria a string "false" como verdadeira, que é
   * exatamente o tipo de configuração que só falha em produção.
   */
  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['', false],
  ])('lê ALLOW_OPEN_REGISTRATION=%s como %s', (raw, expected) => {
    expect(loadEnv({ ...valid, ALLOW_OPEN_REGISTRATION: raw }).ALLOW_OPEN_REGISTRATION).toBe(
      expected,
    )
  })

  it('recusa porta fora da faixa', () => {
    expect(() => loadEnv({ ...valid, PORT: '70000' })).toThrow('PORT')
    expect(() => loadEnv({ ...valid, PORT: '0' })).toThrow('PORT')
  })

  /**
   * A regressão que este teste impede: o `docker-compose.yml` deste repositório
   * declara `PUBLIC_URL: ${PUBLIC_URL:-}` e `METRICS_TOKEN: ${METRICS_TOKEN:-}`
   * para documentar as duas variáveis. Compose entrega isso ao contêiner como
   * string vazia, não como ausente — e o processo morria no boot com
   * "PUBLIC_URL: Invalid url" para quem tinha acabado de baixar o compose.
   */
  it.each(['PUBLIC_URL', 'METRICS_TOKEN', 'DASHBOARD_DIR'] as const)(
    'trata %s vazio como não configurado',
    (chave) => {
      expect(loadEnv({ ...valid, [chave]: '' })[chave]).toBeUndefined()
    },
  )

  /** NODE_ID vazio não é "sem identidade": é "use o hostname", como ausente. */
  it('trata NODE_ID vazio como não configurado', () => {
    expect(loadEnv({ ...valid, NODE_ID: '' }).NODE_ID).toBe(hostname())
  })

  it('só em branco também conta como não configurado', () => {
    expect(loadEnv({ ...valid, PUBLIC_URL: '   ' }).PUBLIC_URL).toBeUndefined()
  })

  /** Vazio vira ausente; errado continua errado. */
  it('continua recusando valor preenchido e inválido', () => {
    expect(() => loadEnv({ ...valid, PUBLIC_URL: 'nao-e-url' })).toThrow('PUBLIC_URL')
    expect(() => loadEnv({ ...valid, METRICS_TOKEN: 'curto-demais' })).toThrow('METRICS_TOKEN')
  })

  it('tira a barra final do PUBLIC_URL', () => {
    expect(loadEnv({ ...valid, PUBLIC_URL: 'https://awah.exemplo.com//' }).PUBLIC_URL).toBe(
      'https://awah.exemplo.com',
    )
  })
})
