import { buildApp } from './app'
import type { Env } from './env'
import { loadEnv } from './env'

interface Aviso {
  warn(obj: object, msg: string): void
}

/**
 * Configurações que só machucam quando a instância vira alcançável.
 *
 * São avisos, não erros: em rede fechada cada uma delas é uma escolha razoável,
 * e derrubar o processo por isso atrapalharia quem só quer rodar no laptop. O
 * que não pode acontecer é a pessoa descobrir depois de exposta.
 */
function avisarSobreExposicao(log: Aviso, env: Env): void {
  if (!env.METRICS_TOKEN) {
    log.warn(
      { rota: '/metrics' },
      'METRICS_TOKEN not set: anyone who reaches the port reads message volume, session count and operational health',
    )
  }

  if (env.TRUST_PROXY === true) {
    log.warn(
      { TRUST_PROXY: true },
      'unrestricted trust in X-Forwarded-For: with no proxy in front, any client picks its own IP and escapes the rate limit',
    )
  }

  if (env.NODE_ENV !== 'production' && env.HOST === '0.0.0.0') {
    log.warn(
      { NODE_ENV: env.NODE_ENV },
      'outside production the session cookie goes without the secure flag; do not expose this instance to the internet like this',
    )
  }
}

async function main() {
  const env = loadEnv()
  const app = await buildApp(env)

  /**
   * Desligamento ordenado: para de aceitar conexão nova, drena o que está em
   * voo e só então fecha Postgres e Redis. A partir da onda 4 é aqui que as
   * sessões também soltam o lease, para que outra réplica assuma na hora em vez
   * de esperar o TTL vencer.
   */
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection')
  })

  avisarSobreExposicao(app.log, env)

  try {
    await app.listen({ port: env.PORT, host: env.HOST })
    const base = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`
    app.log.info(
      {
        versao: process.env.AWAH_VERSION ?? 'dev',
        nodeId: env.NODE_ID,
        painel: base,
        docs: `${base}/docs`,
      },
      'AWAH is up',
    )
  } catch (error) {
    app.log.error({ err: error }, 'failed to start the server')
    process.exit(1)
  }
}

void main()
