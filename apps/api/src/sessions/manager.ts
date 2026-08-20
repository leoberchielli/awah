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
 * O protocolo exige recriar o socket logo depois do pareamento e sinaliza isso
 * com 515. Não é falha: tratar como tal faria a primeira conexão de toda sessão
 * nova esperar o backoff exponencial sem motivo.
 */
const RESTART_REQUIRED = 515
const RESTART_DELAY_MS = 750

/**
 * Superfície mínima de log de que o gerenciador precisa. Aceita tanto o logger
 * do Fastify quanto um pino puro, sem que o gerenciador dependa de nenhum dos
 * dois — o adapter do Baileys, esse sim, exige um pino de verdade e o recebe
 * pronto daqui.
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
  /** O Baileys é muito verboso; por padrão fica em silêncio. */
  engineLogLevel: string
  maxReconnectAttempts?: number
  lease: SessionLease
  qrCache: QrCache
  commands: CommandBus
  /** Intervalo de renovação do lease. Precisa ser bem menor que o TTL. */
  leaseRenewMs?: number
}

interface RunningSession {
  orgId: string
  adapter: EngineAdapter
  attempts: number
  timer: NodeJS.Timeout | null
  /** Renovação periódica da posse. */
  leaseTimer: NodeJS.Timeout | null
  /** Impede que a reconexão automática ressuscite uma sessão que mandamos parar. */
  stopping: boolean
  qrAnnounced: boolean
  clearAuth: () => Promise<void>
}

/**
 * Runtime das sessões neste nó.
 *
 * A onda 1 assume um nó só: quem chamou `start` é dono da sessão enquanto o
 * processo viver. A posse distribuída por lease no Redis entra na onda 4 — os
 * pontos de gancho são `ownerNodeId`, já gravado aqui, e `shutdown`, que a onda
 * 4 estende para soltar o lease em vez de apenas encerrar.
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

  /** Sessões vivas neste nó. O scheduler só busca trabalho para estas. */
  activeSessionIds(): string[] {
    return [...this.running.keys()]
  }

  /** Adapter de uma sessão viva, para o scheduler acionar o envio. */
  adapterFor(sessionId: string): EngineAdapter | null {
    return this.running.get(sessionId)?.adapter ?? null
  }

  orgOf(sessionId: string): string | null {
    return this.running.get(sessionId)?.orgId ?? null
  }

  /**
   * Registra um observador de eventos de mensagem. É por aqui que a persistência
   * de inbound e a reconciliação de ACK se conectam sem que o gerenciador
   * precise conhecer o módulo de mensageria.
   */
  onMessageEvent(handler: MessageEventHandler): void {
    this.messageHandlers.push(handler)
  }

  /** Observadores de mudança de estado da sessão — usado para publicar webhooks. */
  onStatusChange(handler: StatusEventHandler): void {
    this.statusHandlers.push(handler)
  }

  /** Um observador com problema nunca derruba a conexão do WhatsApp. */
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
   * QR corrente. Lê primeiro a memória local e cai no Redis quando a sessão está
   * pareando em outra réplica — a requisição de pareamento pode chegar em
   * qualquer nó.
   */
  async currentQr(sessionId: string): Promise<string | null> {
    const local = this.running.get(sessionId)?.adapter.currentQr()
    if (local) return local
    return this.deps.qrCache.read(sessionId)
  }

  /**
   * Inicia a sessão por pedido do operador.
   *
   * Grava a intenção antes de tentar conectar: se este nó morrer no meio, o
   * failover de outra réplica só sabe que deve assumir porque `desired_state`
   * ficou 'running'.
   */
  async start(orgId: string, sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) {
      throw conflict('This session is already running.')
    }

    await this.repo(orgId).setDesiredState(sessionId, 'running')
    await this.launch(orgId, sessionId)
  }

  /**
   * Assume uma sessão órfã. Não mexe em `desired_state` — a intenção já era
   * 'running', só faltava alguém executá-la.
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
     * A posse vem antes de qualquer coisa.
     *
     * Duas réplicas com o mesmo auth state abrem dois sockets para o mesmo
     * número, e o WhatsApp derruba os dois alternadamente com 440 — o sintoma
     * mais confuso que existe nesse protocolo. O SET NX garante que só um nó
     * ganha, mesmo que todos tentem no mesmo milissegundo.
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
       * A engine oficial não tem pareamento nem socket: o vínculo é o token, e
       * ele é configurado antes do start. Sem credenciais não há o que iniciar.
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
       * Persiste a identidade recém-gerada antes de abrir o socket.
       *
       * O Baileys só emite `creds.update` quando algo muda, e nada muda enquanto
       * o QR está na tela. Sem esta gravação existe uma janela em que o usuário
       * escaneia o código, o processo cai e o aparelho fica com um dispositivo
       * pareado que o banco não conhece — um fantasma que só some manualmente,
       * na lista de dispositivos conectados do celular.
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

    // Passa a atender stop, logout e código de pareamento vindos de outras réplicas.
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
   * Renova a posse. Perder a renovação significa soltar a sessão agora.
   *
   * Insistir seria pior que parar: se o lease expirou, outra réplica já pode ter
   * assumido, e dois sockets no mesmo número derrubam um ao outro.
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

  /** Desmonta o estado local sem tocar no banco nem no socket. */
  private async teardown(sessionId: string): Promise<void> {
    const entry = this.running.get(sessionId)
    this.running.delete(sessionId)

    if (entry?.timer) clearTimeout(entry.timer)
    if (entry?.leaseTimer) clearInterval(entry.leaseTimer)

    await this.deps.commands.unclaim(sessionId)
    await this.deps.lease.release(sessionId)
  }

  /** Executa um comando que chegou por outra réplica. */
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
    // A intenção é gravada mesmo que a sessão rode em outro nó.
    await repoInicial.setDesiredState(sessionId, 'stopped')
    await this.deps.qrCache.clear(sessionId)

    const entry = this.running.get(sessionId)
    if (!entry) {
      // Parar algo que já está parado não é erro — o estado desejado é o mesmo.
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
   * Para a sessão esteja ela onde estiver.
   *
   * Se roda aqui, executa direto. Se roda em outra réplica, o comando viaja até
   * o dono — sem isso, parar uma sessão funcionaria ou não conforme o
   * balanceador escolhesse o nó, que é o tipo de comportamento intermitente
   * impossível de depurar em produção.
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
      // Sem dono: só resta acertar o estado no banco.
      return this.stop(orgId, sessionId, options)
    }

    // A intenção é gravada por quem recebeu, para valer mesmo se o roteamento falhar.
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

  /** Código de pareamento, roteado ao nó dono quando necessário. */
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

  /** Nó que detém a sessão agora, ou null se estiver livre. */
  async ownerOf(sessionId: string): Promise<string | null> {
    return this.deps.lease.owner(sessionId)
  }

  /** Posse de várias sessões numa consulta só. */
  async ownersOf(sessionIds: string[]): Promise<Map<string, string>> {
    return this.deps.lease.owners(sessionIds)
  }

  /** Apaga o auth state de uma sessão que não está rodando. */
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
        // Publicado para que qualquer réplica possa responder à consulta de QR.
        await this.deps.qrCache.publish(sessionId, event.qr)

        // O QR é renovado a cada poucos segundos: registrar todos viraria ruído.
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
        if (event.status === 'connected') return // tratado em 'paired'
        await repo.setStatus(sessionId, event.status)
        await this.notifyStatus(orgId, sessionId, { status: event.status })
        return
      }

      case 'paired': {
        if (entry) {
          entry.attempts = 0
          entry.qrAnnounced = false
        }

        // Pareou: o código deixou de valer.
        await this.deps.qrCache.clear(sessionId)

        const now = new Date()
        const session = await repo.findById(sessionId)

        await repo.setStatus(sessionId, 'connected', {
          phoneNumber: event.phoneNumber,
          lastConnectedAt: now,
          ownerNodeId: this.deps.nodeId,
          // A idade da sessão alimenta a curva de warmup: só marca no 1º pareamento.
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
        // Um observador que falha não pode derrubar os outros nem a sessão.
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

    // O reinício pós-pareamento não é falha, então não consome tentativa.
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
        // Socket que nem abre não emite 'close': reagenda a partir daqui.
        this.scheduleReconnect(orgId, sessionId, entry, null)
      })
    }, delay)
  }

  /**
   * Encerra tudo sem logout — as credenciais seguem válidas para o próximo boot.
   *
   * Soltar os leases explicitamente é o que torna o desligamento planejado
   * rápido: sem isso, as sessões só ficariam livres ao expirar o TTL, e outra
   * réplica levaria até quinze segundos para assumir o que poderia assumir na
   * hora. `desired_state` permanece 'running', então elas voltam sozinhas.
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
