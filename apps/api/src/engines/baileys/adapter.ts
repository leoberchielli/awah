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
  /** Tells a spontaneous drop apart from a shutdown we asked for. */
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
         * A cache in front of the store: without it, every Signal operation
         * turns into a trip to Postgres. With it, hot reads stay in memory and
         * the database only takes writes.
         */
        keys: makeCacheableSignalKeyStore(state.keys, this.deps.logger),
      },
      logger: this.deps.logger,
      browser: Browsers.ubuntu('AWAH'),
      /**
       * Do not mark presence as online on connect. If the gateway announces
       * itself as online, WhatsApp takes it that the user is on the device and
       * stops sending push notifications to their phone — behaviour that
       * surprises anyone using the same number day to day.
       */
      markOnlineOnConnect: false,
      /** Syncing the full history is expensive and no use to a gateway. */
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
     * `notify` is messages arriving right now. The other types (`append`,
     * `prepend`) are history sync, which a gateway must not treat as a new
     * message — otherwise every reconnect would fire webhooks for old
     * conversations.
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
      // Raw text: the route decides whether to serve it as PNG or as a string.
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
        // Ends the device on the phone; the credentials stop being valid.
        await socket.logout()
      } else {
        socket.end(undefined)
      }
    } catch (error) {
      // Shutting down cannot fail: the session goes down either way.
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

  /** `user` is only filled in once pairing has finished. */
  isReady(): boolean {
    return this.socket !== null && Boolean(this.socket.user?.id)
  }

  async sendPresence(chatId: string, state: 'composing' | 'paused' | 'available'): Promise<void> {
    if (!this.isReady() || !this.socket) return

    try {
      await this.socket.sendPresenceUpdate(state, chatId)
    } catch (error) {
      // Presence is cosmetic: failing here must not stop the message going out.
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
