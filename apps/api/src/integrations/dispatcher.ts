import type { Database } from '@awah/db'
import { OutboxRepository } from '../repos/outbox'
import { ChatwootClient, ChatwootError } from './chatwoot/client'
import {
  type ChatwootConfig,
  clearIntegrationError,
  type HttpConfig,
  type LoadedIntegration,
  loadActiveIntegrations,
  recordIntegrationError,
  type TypebotConfig,
} from './config'
import { HttpConnector, HttpConnectorError } from './http/connector'
import { expireLink, findLink, upsertLink } from './links'
import { TypebotClient, TypebotError } from './typebot/client'

export interface DispatcherLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface IncomingMessage {
  orgId: string
  sessionId: string
  chatId: string
  engineMessageId: string
  body: string | null
  fromJid: string | null
  occurredAt: Date
}

export interface IntegrationDispatcherDeps {
  db: Database
  encryptionKey: Buffer
  logger: DispatcherLogger
  maxAttempts: number
  /** Injectable for tests. */
  chatwootFactory?: (config: ChatwootConfig) => ChatwootClient
  typebotFactory?: (config: TypebotConfig) => TypebotClient
  httpFactory?: (config: HttpConfig) => HttpConnector
}

/** Three attempts over ~7 s cover a container restart on the other side. */
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 500

/**
 * Carries what arrives from WhatsApp to the tools wired to the session.
 *
 * The architectural decision behind this: instead of building an inbox and a
 * flow builder of its own, AWAH is the transport for the people who already
 * solved those two things well. What it adds — a durable queue, per-conversation
 * ordering, a risk engine — is exactly what they lack, and it is the reason it
 * is worth putting the gateway underneath instead of wiring Chatwoot straight
 * into Meta.
 */
export class IntegrationDispatcher {
  constructor(private readonly deps: IntegrationDispatcherDeps) {}

  /**
   * Never lets a failure escape.
   *
   * This method runs on the path of the message arriving from the engine; an
   * exception here would take down the event handling and, at the limit, the
   * WhatsApp connection. An external tool being down is its problem, not the
   * session's.
   */
  async onReceive(message: IncomingMessage): Promise<void> {
    if (!message.body?.trim()) return

    let integrations: LoadedIntegration[]
    try {
      integrations = await loadActiveIntegrations(
        this.deps.db,
        message.sessionId,
        this.deps.encryptionKey,
      )
    } catch (error) {
      this.deps.logger.error(
        { err: error, sessionId: message.sessionId },
        'failed to load integrations',
      )
      return
    }

    for (const integration of integrations) {
      try {
        if (integration.row.kind === 'chatwoot') {
          await this.toChatwoot(integration as LoadedIntegration<'chatwoot'>, message)
        } else if (integration.row.kind === 'typebot') {
          await this.toTypebot(integration as LoadedIntegration<'typebot'>, message)
        } else {
          await this.toHttp(integration as LoadedIntegration<'http'>, message)
        }

        if (integration.row.lastError) {
          await clearIntegrationError(this.deps.db, integration.row.id)
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : 'unknown failure'

        this.deps.logger.error(
          { err: error, integrationId: integration.row.id, kind: integration.row.kind },
          'integration failed to process incoming message',
        )

        await recordIntegrationError(this.deps.db, integration.row.id, text).catch(() => undefined)
      }
    }
  }

  private async toChatwoot(
    integration: LoadedIntegration<'chatwoot'>,
    message: IncomingMessage,
  ): Promise<void> {
    const client = this.createChatwoot(integration.config)
    const number = digitsOnly(message.chatId)

    const link = await retry(MAX_ATTEMPTS, async () => {
      const existing = await findLink(this.deps.db, integration.row.id, message.chatId)
      if (existing) return existing

      const contact = await client.ensureContact({
        identifier: number,
        phoneNumber: `+${number}`,
        name: integration.config.fallbackName,
      })

      const conversationId = await client.createConversation({
        sourceId: contact.sourceId,
        contactId: contact.contactId,
      })

      return upsertLink(this.deps.db, {
        integrationId: integration.row.id,
        chatId: message.chatId,
        externalConversationId: conversationId,
        externalContactId: String(contact.contactId),
      })
    })

    await retry(MAX_ATTEMPTS, () =>
      client.buildIncomingMessage({
        conversationId: link.externalConversationId,
        content: message.body ?? '',
        // The WhatsApp id travels along: it is what the webhook coming back
        // uses to recognise what came from here and not echo it straight back.
        sourceId: message.engineMessageId,
      }),
    )
  }

  private async toTypebot(
    integration: LoadedIntegration<'typebot'>,
    message: IncomingMessage,
  ): Promise<void> {
    const text = (message.body ?? '').trim()
    const { humanHandoffKeyword, humanHandoffReply, sessionTtlMinutes } = integration.config

    /**
     * The escape to a human comes before any call to the flow.
     *
     * Someone who types "agent" has already given up on the bot; sending the
     * message to the flow first would produce one more automated reply for
     * exactly the person who asked to stop receiving them.
     */
    if (humanHandoffKeyword && text.toLowerCase() === humanHandoffKeyword.toLowerCase()) {
      await expireLink(this.deps.db, integration.row.id, message.chatId)
      if (humanHandoffReply) {
        await this.enqueueReplies(message, integration.row.id, [humanHandoffReply])
      }
      return
    }

    const client = this.createTypebot(integration.config)
    const link = await findLink(this.deps.db, integration.row.id, message.chatId)

    let turn: Awaited<ReturnType<TypebotClient['start']>>

    if (link) {
      try {
        turn = await client.resume(link.externalConversationId, text)
      } catch (error) {
        // A dead session over there restarts, instead of stranding the contact.
        if (!(error instanceof TypebotError) || !error.sessaoExpirada) throw error
        turn = await client.start(text)
      }
    } else {
      turn = await client.start(text)
    }

    if (turn.sessionId) {
      await upsertLink(this.deps.db, {
        integrationId: integration.row.id,
        chatId: message.chatId,
        externalConversationId: turn.sessionId,
        // A finished flow keeps no session: the next message starts over.
        expiresAt: turn.awaitingReply
          ? new Date(Date.now() + sessionTtlMinutes * 60_000)
          : new Date(),
      })
    }

    await this.enqueueReplies(message, integration.row.id, turn.texts)
  }

  /**
   * The escape hatch to any platform.
   *
   * Posts the event and sends back whatever the response carries. Unlike an
   * ordinary webhook, which tells you and forgets: here the response **is** the
   * message, and that is what lets an n8n flow or a serverless function be the
   * bot without anyone writing a dedicated connector in here.
   */
  private async toHttp(
    integration: LoadedIntegration<'http'>,
    message: IncomingMessage,
  ): Promise<void> {
    const connector = this.createHttp(integration.config)

    const result = await retry(MAX_ATTEMPTS, () =>
      connector.send({
        event: 'message.received',
        data: {
          sessionId: message.sessionId,
          messageId: message.engineMessageId,
          chatId: message.chatId,
          from: message.fromJid,
          type: 'text',
          body: message.body,
          timestamp: message.occurredAt.toISOString(),
        },
      }),
    )

    /**
     * A response that did not become a message is recorded as an error, not
     * swallowed.
     *
     * Silence here is the worst possible outcome: someone who has just plugged
     * in a new platform would be staring at a stalled conversation with no clue
     * that the response format was wrong.
     */
    if (result.diagnosis) {
      throw new Error(result.diagnosis)
    }

    await this.enqueueReplies(message, integration.row.id, result.replies)
  }

  /**
   * The replies enter through the same queue as any other send.
   *
   * That is the point of the arrangement: the flow's reply inherits
   * per-conversation ordering, the risk engine and redelivery. A Typebot wired
   * straight into Meta has none of that — it fires and hopes.
   */
  private async enqueueReplies(
    message: IncomingMessage,
    integrationId: string,
    texts: string[],
  ): Promise<void> {
    if (texts.length === 0) return

    const repo = new OutboxRepository(this.deps.db, message.orgId)

    for (const [index, text] of texts.entries()) {
      await repo.enqueue({
        sessionId: message.sessionId,
        chatId: message.chatId,
        /**
         * The key ties the reply to the message that provoked it.
         *
         * If the same event is processed twice — engine redelivery, a restart
         * halfway through — the outbox recognises the duplicate and the
         * customer does not get the reply twice.
         */
        clientMessageId: `${integrationId}:${message.engineMessageId}:${index}`,
        type: 'text',
        payload: { text: text },
        maxAttempts: this.deps.maxAttempts,
      })
    }
  }

  private createChatwoot(config: ChatwootConfig): ChatwootClient {
    return this.deps.chatwootFactory?.(config) ?? new ChatwootClient(config)
  }

  private createTypebot(config: TypebotConfig): TypebotClient {
    return this.deps.typebotFactory?.(config) ?? new TypebotClient(config)
  }

  private createHttp(config: HttpConfig): HttpConnector {
    return this.deps.httpFactory?.(config) ?? new HttpConnector(config)
  }
}

/**
 * Retries only what is worth retrying.
 *
 * A 4xx from the other side is wrong configuration — invalid token, an inbox
 * that does not exist. Retrying produces the same refusal three times and
 * delays recording the error the operator needs to see.
 */
async function retry<T>(attempts: number, action: () => Promise<T>): Promise<T> {
  let last: unknown

  for (let i = 0; i < attempts; i++) {
    try {
      return await action()
    } catch (error) {
      last = error

      const permanente =
        (error instanceof ChatwootError ||
          error instanceof TypebotError ||
          error instanceof HttpConnectorError) &&
        error.isPermanente
      if (permanente || i === attempts - 1) break

      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** i))
    }
  }

  throw last
}

function digitsOnly(chatId: string): string {
  return chatId.replace(/@.*$/, '').replace(/\D/g, '')
}
