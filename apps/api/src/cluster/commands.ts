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
  /** Dedicated connection: in subscribe mode ioredis refuses normal commands. */
  subscriber: Redis
  nodeId: string
  logger: ManagerLogger
  timeoutMs?: number
}

/**
 * Routes commands to the node that holds the session.
 *
 * Stopping, logging out or asking for a pairing code all need the live socket,
 * which exists in exactly one process. Without routing, these operations would
 * fail seemingly at random — working or not depending on whether the balancer
 * happened to pick the right replica.
 *
 * The pattern is request-reply over pub/sub, with a timeout. If the owner does
 * not answer, the caller gets a clear error instead of silence.
 */
export class CommandBus {
  private readonly timeoutMs: number
  /** Channels subscribed right now, with their handlers. */
  private readonly routes = new Map<string, (message: string) => void>()
  /**
   * One handler per session.
   *
   * Keeping a single one for all of them would be a silent, serious bug: with
   * several sessions on this node, the last `claim` would win and a `logout`
   * meant for one session would run against another.
   */
  private readonly handlers = new Map<string, CommandHandler>()
  private started = false

  constructor(private readonly deps: CommandBusDeps) {
    this.timeoutMs = deps.timeoutMs ?? 10_000
  }

  /**
   * One subscribe connection multiplexes every channel, so per-channel routing
   * lives here instead of opening one connection per session.
   */
  private ensureStarted(): void {
    if (this.started) return
    this.started = true

    this.deps.subscriber.on('message', (channel: string, message: string) => {
      const route = this.routes.get(channel)
      if (route) route(message)
    })
  }

  /** Starts serving commands for this session. Called on acquiring the lease. */
  async claim(sessionId: string, handler: CommandHandler): Promise<void> {
    this.ensureStarted()
    this.handlers.set(sessionId, handler)

    const channel = commandChannel(sessionId)
    this.routes.set(channel, (message) => {
      void this.execute(message)
    })

    await this.deps.subscriber.subscribe(channel)
  }

  /** Stops serving. Called on releasing the lease. */
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
   * Sends the command to the owner and waits for the reply.
   *
   * Subscribing to the reply channel happens before publishing — the other way
   * round, the reply could arrive before anyone was listening for it, and the
   * command would look like it timed out even though it worked.
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
