import makeWASocket, {
  Browsers,
  type ConnectionState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
} from 'baileys'
import type { Logger } from 'pino'
import { badRequest } from '../../lib/errors'
import { describeDisconnect, statusCodeFromError } from '../disconnect'
import type { EngineAdapter, EngineCapabilities, EngineEventHandler, SendResult } from '../types'
import type { PostgresAuthState } from './auth-state'
import { extractContent, mapStatus, toDate } from './mapping'

export interface BaileysAdapterDeps {
  sessionId: string
  authState: PostgresAuthState
  logger: Logger
  onEvent: EngineEventHandler
}

const CAPABILITIES: EngineCapabilities = {
  qrPairing: true,
  codePairing: true,
  groups: true,
  channels: true,
  presence: true,
  reactions: true,
  editMessage: true,
  freeformMessaging: true,
}

/** `5511999999999:12@s.whatsapp.net` → `5511999999999`. */
export function phoneFromJid(jid: string | undefined | null): string | null {
  if (!jid) return null
  const [local] = jid.split('@')
  if (!local) return null
  const [number] = local.split(':')
  return number && /^\d+$/.test(number) ? number : null
}

export class BaileysAdapter implements EngineAdapter {
  readonly engine = 'baileys' as const
  readonly capabilities = CAPABILITIES

  private socket: WASocket | null = null
  private qr: string | null = null
  /** Distingue queda espontânea de desligamento pedido por nós. */
  private intentionalClose = false

  constructor(private readonly deps: BaileysAdapterDeps) {}

  async connect(): Promise<void> {
    this.intentionalClose = false

    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = this.deps.authState

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        /**
         * Cache na frente do store: sem ele, cada operação do Signal vira ida ao
         * Postgres. Com ele, a leitura quente fica em memória e o banco só recebe
         * escrita.
         */
        keys: makeCacheableSignalKeyStore(state.keys, this.deps.logger),
      },
      logger: this.deps.logger,
      browser: Browsers.ubuntu('AWAH'),
      /**
       * Não marcar presença online ao conectar. Se o gateway se anuncia online,
       * o WhatsApp entende que o usuário está no aparelho e para de mandar
       * notificação push para o celular dele — comportamento que surpreende
       * qualquer um que use o mesmo número no dia a dia.
       */
      markOnlineOnConnect: false,
      /** Sincronizar histórico completo é caro e não serve a um gateway. */
      syncFullHistory: false,
    })

    this.socket.ev.on('creds.update', () => {
      void saveCreds().catch((error) => {
        this.deps.logger.error({ err: error }, 'failed to save credentials')
      })
      this.deps.onEvent({ type: 'credentials' })
    })

    this.socket.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(update)
    })

    /**
     * `notify` são mensagens chegando agora. Os outros tipos (`append`, `prepend`)
     * são sincronização de histórico, que um gateway não deve tratar como
     * mensagem nova — senão cada reconexão dispararia webhooks de conversas
     * antigas.
     */
    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return

      for (const message of messages) {
        const chatId = message.key?.remoteJid
        const engineMessageId = message.key?.id
        if (!chatId || !engineMessageId) continue

        const content = extractContent(message.message)

        this.deps.onEvent({
          type: 'message.received',
          engineMessageId,
          chatId,
          fromJid: message.key.participant ?? (message.key.fromMe ? null : chatId),
          messageType: content.type,
          body: content.body,
          fromMe: Boolean(message.key.fromMe),
          occurredAt: toDate(message.messageTimestamp),
        })
      }
    })

    this.socket.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const status = mapStatus(update?.status)
        if (!status || !key?.id || !key.remoteJid) continue

        this.deps.onEvent({
          type: 'message.status',
          engineMessageId: key.id,
          chatId: key.remoteJid,
          status,
          occurredAt: new Date(),
        })
      }
    })
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Texto cru: a rota decide se entrega como PNG ou como string.
      this.qr = qr
      this.deps.onEvent({ type: 'qr', qr })
      this.deps.onEvent({ type: 'status', status: 'pairing' })
    }

    if (connection === 'connecting') {
      this.deps.onEvent({ type: 'status', status: 'connecting' })
    }

    if (connection === 'open') {
      this.qr = null
      this.deps.onEvent({ type: 'paired', phoneNumber: phoneFromJid(this.socket?.user?.id) })
      this.deps.onEvent({ type: 'status', status: 'connected' })
    }

    if (connection === 'close') {
      this.qr = null
      const rawCode = statusCodeFromError(lastDisconnect?.error)
      const info = describeDisconnect(rawCode)

      this.deps.onEvent({
        type: 'closed',
        rawCode,
        cause: this.intentionalClose ? 'Shut down by command' : info.cause,
        shouldReconnect: !this.intentionalClose && info.shouldReconnect,
        loggedOut: info.loggedOut,
      })
    }
  }

  async disconnect(options?: { logout?: boolean }): Promise<void> {
    this.intentionalClose = true
    const socket = this.socket
    this.socket = null
    this.qr = null

    if (!socket) return

    try {
      if (options?.logout) {
        // Encerra o dispositivo no aparelho; as credenciais deixam de valer.
        await socket.logout()
      } else {
        socket.end(undefined)
      }
    } catch (error) {
      // Desligar não pode falhar: a sessão sai do ar de qualquer maneira.
      this.deps.logger.warn({ err: error }, 'error closing socket, continuing')
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.socket) {
      throw badRequest('The session must be started before requesting a pairing code.')
    }

    const digits = phoneNumber.replace(/\D/g, '')
    if (digits.length < 10) {
      throw badRequest('Give the number with country code, digits only. Example: 5511999999999')
    }

    return this.socket.requestPairingCode(digits)
  }

  currentQr(): string | null {
    return this.qr
  }

  /** `user` só é preenchido depois do pareamento concluído. */
  isReady(): boolean {
    return this.socket !== null && Boolean(this.socket.user?.id)
  }

  async sendPresence(chatId: string, state: 'composing' | 'paused' | 'available'): Promise<void> {
    if (!this.isReady() || !this.socket) return

    try {
      await this.socket.sendPresenceUpdate(state, chatId)
    } catch (error) {
      // Presença é cosmética: falhar aqui não pode impedir a mensagem de sair.
      this.deps.logger.debug({ err: error, chatId }, 'failed to update presence')
    }
  }

  async sendText(chatId: string, text: string): Promise<SendResult> {
    if (!this.isReady()) {
      throw badRequest('The session is not paired. Finish pairing before sending.')
    }
    if (!this.socket) {
      throw badRequest('The session is not connected.')
    }

    const sent = await this.socket.sendMessage(chatId, { text })
    if (!sent?.key?.id) {
      throw new Error('the engine did not return a message id')
    }

    return { engineMessageId: sent.key.id, timestamp: new Date() }
  }
}
