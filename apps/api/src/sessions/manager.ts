import type { Database, SessionStatus } from '@awah/db'
import pino from 'pino'
import type { CommandBus } from '../cluster/commands'
import type { SessionLease } from '../cluster/lease'
import type { QrCache } from '../cluster/qr-cache'
import { BaileysAdapter } from '../engines/baileys/adapter'
import { usePostgresAuthState } from '../engines/baileys/auth-state'
import { CloudApiAdapter } from '../engines/cloud-api/adapter'
import { clearCloudApiCredentials, loadCloudApiCredentials } from '../engines/cloud-api/credentials'
import { reconnectDelayMs } from '../engines/disconnect'
import type { EngineAdapter, EngineEvent } from '../engines/types'

import { badRequest, conflict, notFound } from '../lib/errors'
import { SessionRepository } from '../repos/sessions'

/**
 * The protocol requires the socket to be recreated right after pairing, and
 * signals that with 515. It is not a failure: treating it as one would make the
 * first connection of every new session sit through exponential backoff for no
 * reason.
 */
const RESTART_REQUIRED = 515
const RESTART_DELAY_MS = 750

/**
 * The minimal logging surface the manager needs. It takes either the Fastify
 * logger or a bare pino, without the manager depending on either one — the
 * Baileys adapter, on the other hand, does need a real pino, and gets one ready
 * made from here.
 */
export interface ManagerLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface SessionManagerDeps {
  db: Database
  logger: ManagerLogger
  nodeId: string
  encryptionKey: Buffer
  /** Baileys is very noisy; by default it is kept quiet. */
  engineLogLevel: string
  maxReconnectAttempts?: number
  lease: SessionLease
  qrCache: QrCache
  commands: CommandBus
  /** Lease renewal interval. It has to be well under the TTL. */
  leaseRenewMs?: number
}

interface RunningSession {
  orgId: string
  adapter: EngineAdapter
  attempts: number
  timer: NodeJS.Timeout | null
  /** Periodic renewal of ownership. */
  leaseTimer: NodeJS.Timeout | null
  /** Stops automatic reconnection from reviving a session we told to stop. */
  stopping: boolean
  qrAnnounced: boolean
  clearAuth: () => Promise<void>
}

/**
 * Session runtime on this node.
 *
 * Wave 1 assumes a single node: whoever called `start` owns the session for as
 * long as the process lives. Ownership distributed by a Redis lease arrives in
 * wave 4 — the hook points are `ownerNodeId`, already written here, and
 * `shutdown`, which wave 4 extends to release the lease instead of only closing
 * down.
 */
export type MessageEventHandler = (
  context: { orgId: string; sessionId: string },
  event: Extract<EngineEvent, { type: 'message.received' | 'message.status' }>,
) => Promise<void>

export type StatusEventHandler = (
  context: { orgId: string; sessionId: string },
  payload: { status: SessionStatus; cause?: string | null; rawCode?: number | null },
) => Promise<void>

export class SessionManager {
  private readonly running = new Map<string, RunningSession>()
  private readonly messageHandlers: MessageEventHandler[] = []
  private readonly statusHandlers: StatusEventHandler[] = []
  private readonly maxAttempts: number
  private readonly leaseRenewMs: number

  constructor(private readonly deps: SessionManagerDeps) {
    this.maxAttempts = deps.maxReconnectAttempts ?? 10
    this.leaseRenewMs = deps.leaseRenewMs ?? 5000
  }

  private repo(orgId: string): SessionRepository {
    return new SessionRepository(this.deps.db, orgId)
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Sessions alive on this node. The scheduler only fetches work for these. */
  activeSessionIds(): string[] {
    return [...this.running.keys()]
  }

  /** The adapter of a live session, for the scheduler to drive the send. */
  adapterFor(sessionId: string): EngineAdapter | null {
    return this.running.get(sessionId)?.adapter ?? null
  }

  orgOf(sessionId: string): string | null {
    return this.running.get(sessionId)?.orgId ?? null
  }

  /**
   * Registers an observer of message events. This is where inbound persistence
   * and ACK reconciliation hook in without the manager having to know anything
   * about the messaging module.
   */
  onMessageEvent(handler: MessageEventHandler): void {
    this.messageHandlers.push(handler)
  }

  /** Observers of session state changes — used to publish webhooks. */
  onStatusChange(handler: StatusEventHandler): void {
    this.statusHandlers.push(handler)
  }

  /** A broken observer never takes the WhatsApp connection down. */
  private async notifyStatus(
    orgId: string,
    sessionId: string,
    payload: { status: SessionStatus; cause?: string | null; rawCode?: number | null },
  ): Promise<void> {
    if (this.statusHandlers.length === 0) return

    const results = await Promise.allSettled(
      this.statusHandlers.map((handler) => handler({ orgId, sessionId }, payload)),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        this.deps.logger.error({ err: result.reason, sessionId }, 'status observer failed')
      }
    }
  }

  /**
   * The current QR. Reads local memory first and falls back to Redis when the
   * session is pairing on another replica — the pairing request can land on any
   * node.
   */
  async currentQr(sessionId: string): Promise<string | null> {
    const local = this.running.get(sessionId)?.adapter.currentQr()
    if (local) return local
    return this.deps.qrCache.read(sessionId)
  }

  /**
   * Starts the session at the operator's request.
   *
   * Writes the intent before trying to connect: if this node dies halfway, the
   * failover on another replica only knows it should take over because
   * `desired_state` was left at 'running'.
   */
  async start(orgId: string, sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) {
      throw conflict('This session is already running.')
    }

    await this.repo(orgId).setDesiredState(sessionId, 'running')
    await this.launch(orgId, sessionId)
  }

  /**
   * Takes over an orphan session. Does not touch `desired_state` — the intent
   * was already 'running', it just needed someone to carry it out.
   */
  async adopt(orgId: string, sessionId: string): Promise<boolean> {
    if (this.running.has(sessionId)) return false

    try {
      await this.launch(orgId, sessionId)
      return true
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId }, 'could not adopt orphan session')
      return false
    }
  }

  private async launch(orgId: string, sessionId: string): Promise<void> {
    const repo = this.repo(orgId)
    const session = await repo.findById(sessionId)
    if (!session) throw notFound('Session not found.')

    if (session.engine !== 'baileys' && session.engine !== 'cloud_api') {
      throw badRequest(
        `Engine "${session.engine}" is not implemented yet. Available in this version: baileys, cloud_api.`,
      )
    }

    /**
     * Ownership comes before anything else.
     *
     * Two replicas with the same auth state open two sockets to the same
     * number, and WhatsApp knocks both of them down in turn with 440 — the most
     * confusing symptom this protocol has. The SET NX guarantees that only one
     * node wins, even if they all try in the same millisecond.
     */
    if (!(await this.deps.lease.acquire(sessionId))) {
      const dono = await this.deps.lease.owner(sessionId)
      throw conflict(
        `This session is running on node ${dono ?? 'unknown'}. Commands are routed automatically; there is no need to start it again.`,
      )
    }

    const onEvent = (event: EngineEvent) => {
      void this.handleEvent(orgId, sessionId, event).catch((error) => {
        this.deps.logger.error({ err: error, sessionId }, 'failed to handle engine event')
      })
    }

    let adapter: EngineAdapter
    let clearAuth: () => Promise<void>

    if (session.engine === 'cloud_api') {
      /**
       * The official engine has no pairing and no socket: the link is the
       * token, and it is configured before the start. With no credentials there
       * is nothing to start.
       */
      const credentials = await loadCloudApiCredentials(
        this.deps.db,
        sessionId,
        this.deps.encryptionKey,
      )
      if (!credentials) {
        await this.deps.lease.release(sessionId)
        throw badRequest(
          'Configure the Cloud API credentials at PUT /v1/sessions/:id/credentials before starting.',
        )
      }

      adapter = new CloudApiAdapter({ sessionId, credentials, onEvent })
      clearAuth = () => clearCloudApiCredentials(this.deps.db, sessionId)
    } else {
      const auth = await usePostgresAuthState({
        db: this.deps.db,
        sessionId,
        encryptionKey: this.deps.encryptionKey,
      })

      /**
       * Persist the freshly generated identity before opening the socket.
       *
       * Baileys only emits `creds.update` when something changes, and nothing
       * changes while the QR is on screen. Without this write there is a window
       * where the user scans the code, the process dies, and the phone is left
       * with a paired device the database knows nothing about — a ghost that
       * only goes away by hand, from the linked devices list on the phone.
       */
      if (auth.isNew) {
        await auth.saveCreds()
      }

      adapter = new BaileysAdapter({
        sessionId,
        authState: auth,
        logger: pino({
          level: this.deps.engineLogLevel,
          base: { sessionId, component: 'baileys' },
        }),
        onEvent,
      })
      clearAuth = auth.clear
    }

    const entry: RunningSession = {
      orgId,
      adapter,
      attempts: 0,
      timer: null,
      leaseTimer: null,
      stopping: false,
      qrAnnounced: false,
      clearAuth,
    }
    this.running.set(sessionId, entry)

    // Starts serving stop, logout and pairing code coming from other replicas.
    await this.deps.commands.claim(sessionId, (request) =>
      this.handleCommand(orgId, sessionId, request.command, request.payload),
    )

    entry.leaseTimer = setInterval(() => {
      void this.renewLease(orgId, sessionId)
    }, this.leaseRenewMs)
    entry.leaseTimer.unref()

    await repo.setStatus(sessionId, 'connecting', { ownerNodeId: this.deps.nodeId })
    await repo.recordEvent({
      sessionId,
      type: 'lease_acquired',
      cause: `Ownership acquired by node ${this.deps.nodeId}`,
      nodeId: this.deps.nodeId,
    })
    await repo.recordEvent({
      sessionId,
      type: 'connecting',
      nodeId: this.deps.nodeId,
    })

    try {
      await adapter.connect()
    } catch (error) {
      await this.teardown(sessionId)
      await repo.setStatus(sessionId, 'disconnected', { ownerNodeId: null })
      await repo.recordEvent({
        sessionId,
        type: 'error',
        cause: error instanceof Error ? error.message : 'failed to connect',
        nodeId: this.deps.nodeId,
      })
      throw error
    }
  }

  /**
   * Renews ownership. Losing the renewal means releasing the session now.
   *
   * Pushing on would be worse than stopping: if the lease expired, another
   * replica may already have taken over, and two sockets on the same number
   * knock each other down.
   */
  private async renewLease(orgId: string, sessionId: string): Promise<void> {
    try {
      if (await this.deps.lease.renew(sessionId)) return
    } catch (error) {
      this.deps.logger.error({ err: error, sessionId }, 'failed to renew ownership')
      return
    }

    this.deps.logger.warn({ sessionId }, 'ownership lost, releasing session')

    const entry = this.running.get(sessionId)
    if (entry) entry.stopping = true

    await this.teardown(sessionId)
    await entry?.adapter.disconnect()

    const repo = this.repo(orgId)
    await repo.recordEvent({
      sessionId,
      type: 'lease_lost',
      cause: 'Ownership expired and was taken over by another node',
      nodeId: this.deps.nodeId,
    })
  }

  /** Tears down the local state without touching the database or the socket. */
  private async teardown(sessionId: string): Promise<void> {
    const entry = this.running.get(sessionId)
    this.running.delete(sessionId)

    if (entry?.timer) clearTimeout(entry.timer)
    if (entry?.leaseTimer) clearInterval(entry.leaseTimer)

    await this.deps.commands.unclaim(sessionId)
    await this.deps.lease.release(sessionId)
  }

  /** Runs a command that arrived from another replica. */
  private async handleCommand(
    orgId: string,
    sessionId: string,
    command: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    switch (command) {
      case 'stop':
        await this.stop(orgId, sessionId)
        return { status: 'disconnected' }

      case 'logout':
        await this.stop(orgId, sessionId, { logout: true })
        return { status: 'logged_out' }

      case 'pairing-code': {
        const phoneNumber = typeof payload?.phoneNumber === 'string' ? payload.phoneNumber : ''
        return { code: await this.requestPairingCode(orgId, sessionId, phoneNumber) }
      }

      default:
        throw new Error(`unknown command: ${command}`)
    }
  }

  async stop(orgId: string, sessionId: string, options?: { logout?: boolean }): Promise<void> {
    const repoInicial = this.repo(orgId)
    // The intent is written even if the session runs on another node.
    await repoInicial.setDesiredState(sessionId, 'stopped')
    await this.deps.qrCache.clear(sessionId)

    const entry = this.running.get(sessionId)
    if (!entry) {
      // Stopping something already stopped is not an error — same desired state.
      if (options?.logout) await this.clearCredentials(orgId, sessionId)
      return
    }

    entry.stopping = true
    await this.teardown(sessionId)

    await entry.adapter.disconnect({ logout: options?.logout ?? false })

    const repo = repoInicial
    if (options?.logout) {
      await entry.clearAuth()
      await repo.setStatus(sessionId, 'logged_out', {
        ownerNodeId: null,
        phoneNumber: null,
        lastDisconnectedAt: new Date(),
      })
      await repo.recordEvent({
        sessionId,
        type: 'logged_out',
        cause: 'Logout requested',
        nodeId: this.deps.nodeId,
      })
    } else {
      await repo.setStatus(sessionId, 'disconnected', {
        ownerNodeId: null,
        lastDisconnectedAt: new Date(),
      })
      await repo.recordEvent({
        sessionId,
        type: 'disconnected',
        cause: 'Stopped by command',
        nodeId: this.deps.nodeId,
      })
    }
  }

  /**
   * Stops the session wherever it happens to be.
   *
   * If it runs here, it runs straight away. If it runs on another replica, the
   * command travels to the owner — without this, stopping a session would work
   * or not depending on the node the balancer picked, which is the kind of
   * intermittent behaviour that is impossible to debug in production.
   */
  async stopAnywhere(
    orgId: string,
    sessionId: string,
    options?: { logout?: boolean },
  ): Promise<void> {
    if (this.running.has(sessionId)) {
      return this.stop(orgId, sessionId, options)
    }

    const dono = await this.deps.lease.owner(sessionId)
    if (!dono || dono === this.deps.nodeId) {
      // No owner: all that is left is to set the state right in the database.
      return this.stop(orgId, sessionId, options)
    }

    // The receiving node writes the intent, so it holds even if routing fails.
    await this.repo(orgId).setDesiredState(sessionId, 'stopped')

    const resposta = await this.deps.commands.send({
      sessionId,
      orgId,
      command: options?.logout ? 'logout' : 'stop',
    })

    if (!resposta.ok) {
      throw conflict(`Failed to forward the command to node ${dono}: ${resposta.error}`)
    }
  }

  /** Pairing code, routed to the owner node when needed. */
  async requestPairingCodeAnywhere(
    orgId: string,
    sessionId: string,
    phoneNumber: string,
  ): Promise<string> {
    if (this.running.has(sessionId)) {
      return this.requestPairingCode(orgId, sessionId, phoneNumber)
    }

    const dono = await this.deps.lease.owner(sessionId)
    if (!dono || dono === this.deps.nodeId) {
      throw badRequest('Start the session before requesting a pairing code.')
    }

    const resposta = await this.deps.commands.send({
      sessionId,
      orgId,
      command: 'pairing-code',
      payload: { phoneNumber },
    })

    if (!resposta.ok) {
      throw conflict(`Failed to forward the command to node ${dono}: ${resposta.error}`)
    }

    const code = (resposta.result as { code?: unknown } | undefined)?.code
    if (typeof code !== 'string') {
      throw conflict('The owner node returned an unexpected response.')
    }
    return code
  }

  /** The node that holds the session right now, or null if it is free. */
  async ownerOf(sessionId: string): Promise<string | null> {
    return this.deps.lease.owner(sessionId)
  }

  /** Ownership of several sessions in a single query. */
  async ownersOf(sessionIds: string[]): Promise<Map<string, string>> {
    return this.deps.lease.owners(sessionIds)
  }

  /** Wipes the auth state of a session that is not running. */
  private async clearCredentials(orgId: string, sessionId: string): Promise<void> {
    const auth = await usePostgresAuthState({
      db: this.deps.db,
      sessionId,
      encryptionKey: this.deps.encryptionKey,
    })
    await auth.clear()
    await this.repo(orgId).setStatus(sessionId, 'logged_out', { phoneNumber: null })
  }

  async requestPairingCode(orgId: string, sessionId: string, phoneNumber: string): Promise<string> {
    const entry = this.running.get(sessionId)
    if (!entry) {
      throw badRequest('Start the session before requesting a pairing code.')
    }

    const code = await entry.adapter.requestPairingCode(phoneNumber)
    await this.repo(orgId).recordEvent({
      sessionId,
      type: 'pairing_requested',
      cause: 'Pairing code requested',
      nodeId: this.deps.nodeId,
    })

    return code
  }

  private async handleEvent(orgId: string, sessionId: string, event: EngineEvent): Promise<void> {
    const repo = this.repo(orgId)
    const entry = this.running.get(sessionId)

    switch (event.type) {
      case 'qr': {
        // Published so that any replica can answer the QR query.
        await this.deps.qrCache.publish(sessionId, event.qr)

        // The QR is refreshed every few seconds: recording each one would be noise.
        if (entry && !entry.qrAnnounced) {
          entry.qrAnnounced = true
          await repo.setStatus(sessionId, 'pairing')
          await repo.recordEvent({
            sessionId,
            type: 'pairing_requested',
            cause: 'QR generated',
            nodeId: this.deps.nodeId,
          })
        }
        return
      }

      case 'status': {
        if (event.status === 'connected') return // handled in 'paired'
        await repo.setStatus(sessionId, event.status)
        await this.notifyStatus(orgId, sessionId, { status: event.status })
        return
      }

      case 'paired': {
        if (entry) {
          entry.attempts = 0
          entry.qrAnnounced = false
        }

        // Paired: the code stops being valid.
        await this.deps.qrCache.clear(sessionId)

        const now = new Date()
        const session = await repo.findById(sessionId)

        await repo.setStatus(sessionId, 'connected', {
          phoneNumber: event.phoneNumber,
          lastConnectedAt: now,
          ownerNodeId: this.deps.nodeId,
          // Session age feeds the warm-up curve: only stamped on the 1st pairing.
          ...(session?.pairedAt ? {} : { pairedAt: now }),
        })

        await repo.recordEvent({
          sessionId,
          type: session?.pairedAt ? 'connected' : 'paired',
          cause: session?.pairedAt ? 'Connected' : 'Paired',
          nodeId: this.deps.nodeId,
        })

        await this.notifyStatus(orgId, sessionId, {
          status: 'connected',
          cause: session?.pairedAt ? 'Connected' : 'Paired',
        })
        return
      }

      case 'credentials':
        return

      case 'message.received':
      case 'message.status': {
        // One failing observer must not take down the others or the session.
        await Promise.allSettled(
          this.messageHandlers.map((handler) => handler({ orgId, sessionId }, event)),
        ).then((results) => {
          for (const result of results) {
            if (result.status === 'rejected') {
              this.deps.logger.error(
                { err: result.reason, sessionId, event: event.type },
                'message observer failed',
              )
            }
          }
        })
        return
      }

      case 'closed': {
        await repo.recordEvent({
          sessionId,
          type: event.loggedOut ? 'logged_out' : 'disconnected',
          rawCode: event.rawCode,
          cause: event.cause,
          nodeId: this.deps.nodeId,
        })

        await this.notifyStatus(orgId, sessionId, {
          status: event.loggedOut ? 'logged_out' : 'disconnected',
          cause: event.cause,
          rawCode: event.rawCode,
        })

        if (event.loggedOut) {
          this.running.delete(sessionId)
          if (entry?.timer) clearTimeout(entry.timer)
          await entry?.clearAuth()
          await repo.setStatus(sessionId, 'logged_out', {
            ownerNodeId: null,
            phoneNumber: null,
            lastDisconnectedAt: new Date(),
          })
          return
        }

        await repo.setStatus(sessionId, 'disconnected', { lastDisconnectedAt: new Date() })

        if (!entry || entry.stopping || !event.shouldReconnect) {
          this.running.delete(sessionId)
          await repo.setStatus(sessionId, 'disconnected', { ownerNodeId: null })
          return
        }

        this.scheduleReconnect(orgId, sessionId, entry, event.rawCode)
        return
      }
    }
  }

  private scheduleReconnect(
    orgId: string,
    sessionId: string,
    entry: RunningSession,
    rawCode: number | null,
  ): void {
    const isRestart = rawCode === RESTART_REQUIRED

    // The post-pairing restart is not a failure, so it spends no attempt.
    if (!isRestart) entry.attempts += 1

    if (entry.attempts > this.maxAttempts) {
      this.deps.logger.warn(
        { sessionId, attempts: entry.attempts },
        'reconnect limit reached, giving up',
      )
      this.running.delete(sessionId)
      void this.repo(orgId)
        .recordEvent({
          sessionId,
          type: 'error',
          cause: `Gave up reconnecting after ${this.maxAttempts} attempts`,
          nodeId: this.deps.nodeId,
        })
        .catch(() => {})
      return
    }

    const delay = isRestart ? RESTART_DELAY_MS : reconnectDelayMs(entry.attempts)
    this.deps.logger.info({ sessionId, delay, attempt: entry.attempts }, 'reconnecting')

    entry.timer = setTimeout(() => {
      if (entry.stopping) return

      void entry.adapter.connect().catch((error) => {
        this.deps.logger.error({ err: error, sessionId }, 'failed to reconnect')
        // A socket that never opens emits no 'close': reschedule from here.
        this.scheduleReconnect(orgId, sessionId, entry, null)
      })
    }, delay)
  }

  /**
   * Shuts everything down without logging out — the credentials stay valid for
   * the next boot.
   *
   * Releasing the leases explicitly is what makes a planned shutdown fast:
   * without it, sessions would only come free once the TTL expired, and another
   * replica would take up to fifteen seconds to pick up what it could pick up
   * right away. `desired_state` stays 'running', so they come back on their own.
   */
  async shutdown(): Promise<void> {
    const entries = [...this.running.entries()]

    await Promise.allSettled(
      entries.map(async ([sessionId, entry]) => {
        entry.stopping = true
        await this.teardown(sessionId)
        await entry.adapter.disconnect()
        await this.repo(entry.orgId).setStatus(sessionId, 'disconnected', {
          ownerNodeId: null,
          lastDisconnectedAt: new Date(),
        })
      }),
    )

    this.running.clear()
  }
}
