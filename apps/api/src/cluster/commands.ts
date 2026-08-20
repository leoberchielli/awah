import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import type { ManagerLogger } from '../sessions/manager'

export type SessionCommand = 'stop' | 'logout' | 'pairing-code'

export interface CommandRequest {
  id: string
  command: SessionCommand
  sessionId: string
  orgId: string
  payload?: Record<string, unknown>
  replyChannel: string
}

export interface CommandResult {
  ok: boolean
  result?: unknown
  error?: string
}

export type CommandHandler = (request: CommandRequest) => Promise<unknown>

export interface CommandBusDeps {
  publisher: Redis
  /** Conexão dedicada: em modo subscribe o ioredis recusa comandos normais. */
  subscriber: Redis
  nodeId: string
  logger: ManagerLogger
  timeoutMs?: number
}

/**
 * Roteamento de comandos para o nó que detém a sessão.
 *
 * Parar, deslogar ou pedir código de pareamento exigem o socket vivo, que existe
 * em um processo só. Sem roteamento, essas operações falhariam de forma
 * aparentemente aleatória — funcionando ou não conforme o balanceador escolhesse
 * a réplica certa.
 *
 * O padrão é request-reply sobre pub/sub, com timeout. Se o dono não responder,
 * quem pediu recebe um erro claro em vez de silêncio.
 */
export class CommandBus {
  private readonly timeoutMs: number
  /** Canais assinados agora, com seus tratadores. */
  private readonly routes = new Map<string, (message: string) => void>()
  /**
   * Um tratador por sessão.
   *
   * Guardar um só para todas seria um bug silencioso e grave: com várias sessões
   * neste nó, o último `claim` venceria e um `logout` destinado a uma sessão
   * seria executado em outra.
   */
  private readonly handlers = new Map<string, CommandHandler>()
  private started = false

  constructor(private readonly deps: CommandBusDeps) {
    this.timeoutMs = deps.timeoutMs ?? 10_000
  }

  /**
   * Uma conexão de subscribe multiplexa todos os canais, então o roteamento por
   * canal fica aqui em vez de abrir uma conexão por sessão.
   */
  private ensureStarted(): void {
    if (this.started) return
    this.started = true

    this.deps.subscriber.on('message', (channel: string, message: string) => {
      const route = this.routes.get(channel)
      if (route) route(message)
    })
  }

  /** Passa a atender comandos desta sessão. Chamado ao adquirir o lease. */
  async claim(sessionId: string, handler: CommandHandler): Promise<void> {
    this.ensureStarted()
    this.handlers.set(sessionId, handler)

    const channel = commandChannel(sessionId)
    this.routes.set(channel, (message) => {
      void this.execute(message)
    })

    await this.deps.subscriber.subscribe(channel)
  }

  /** Deixa de atender. Chamado ao soltar o lease. */
  async unclaim(sessionId: string): Promise<void> {
    const channel = commandChannel(sessionId)
    this.routes.delete(channel)
    this.handlers.delete(sessionId)

    try {
      await this.deps.subscriber.unsubscribe(channel)
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId }, 'failed to unsubscribe from command channel')
    }
  }

  private async execute(raw: string): Promise<void> {
    let request: CommandRequest
    try {
      request = JSON.parse(raw) as CommandRequest
    } catch {
      return
    }

    const handler = this.handlers.get(request.sessionId)
    if (!handler) return

    let response: CommandResult
    try {
      response = { ok: true, result: await handler(request) }
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    await this.deps.publisher.publish(request.replyChannel, JSON.stringify(response))
  }

  /**
   * Envia o comando ao dono e espera a resposta.
   *
   * A assinatura do canal de resposta acontece antes da publicação — invertida,
   * a resposta poderia chegar antes de haver quem a escutasse, e o comando
   * pareceria ter dado timeout mesmo tendo funcionado.
   */
  async send(input: {
    sessionId: string
    orgId: string
    command: SessionCommand
    payload?: Record<string, unknown>
  }): Promise<CommandResult> {
    this.ensureStarted()

    const id = randomUUID()
    const replyChannel = `awah:reply:${id}`

    const request: CommandRequest = {
      id,
      command: input.command,
      sessionId: input.sessionId,
      orgId: input.orgId,
      replyChannel,
      ...(input.payload ? { payload: input.payload } : {}),
    }

    return new Promise<CommandResult>((resolve) => {
      const finish = (result: CommandResult) => {
        clearTimeout(timer)
        this.routes.delete(replyChannel)
        void this.deps.subscriber.unsubscribe(replyChannel).catch(() => {})
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: `The node holding the session did not respond within ${this.timeoutMs}ms.`,
        })
      }, this.timeoutMs)

      this.routes.set(replyChannel, (message) => {
        try {
          finish(JSON.parse(message) as CommandResult)
        } catch {
          finish({ ok: false, error: 'unreadable response from the owner node' })
        }
      })

      void this.deps.subscriber
        .subscribe(replyChannel)
        .then(() =>
          this.deps.publisher.publish(commandChannel(input.sessionId), JSON.stringify(request)),
        )
        .catch((error) => {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        })
    })
  }

  async close(): Promise<void> {
    this.routes.clear()
    this.handlers.clear()
  }
}

function commandChannel(sessionId: string): string {
  return `awah:cmd:${sessionId}`
}
