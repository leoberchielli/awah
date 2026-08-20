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

export interface MensagemRecebida {
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
const TENTATIVAS = 3
const ESPERA_BASE_MS = 500

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
  async aoReceber(mensagem: MensagemRecebida): Promise<void> {
    if (!mensagem.body?.trim()) return

    let integracoes: LoadedIntegration[]
    try {
      integracoes = await loadActiveIntegrations(
        this.deps.db,
        mensagem.sessionId,
        this.deps.encryptionKey,
      )
    } catch (erro) {
      this.deps.logger.error(
        { err: erro, sessionId: mensagem.sessionId },
        'failed to load integrations',
      )
      return
    }

    for (const integracao of integracoes) {
      try {
        if (integracao.row.kind === 'chatwoot') {
          await this.paraChatwoot(integracao as LoadedIntegration<'chatwoot'>, mensagem)
        } else if (integracao.row.kind === 'typebot') {
          await this.paraTypebot(integracao as LoadedIntegration<'typebot'>, mensagem)
        } else {
          await this.paraHttp(integracao as LoadedIntegration<'http'>, mensagem)
        }

        if (integracao.row.lastError) {
          await clearIntegrationError(this.deps.db, integracao.row.id)
        }
      } catch (erro) {
        const texto = erro instanceof Error ? erro.message : 'unknown failure'

        this.deps.logger.error(
          { err: erro, integrationId: integracao.row.id, kind: integracao.row.kind },
          'integration failed to process incoming message',
        )

        await recordIntegrationError(this.deps.db, integracao.row.id, texto).catch(() => undefined)
      }
    }
  }

  private async paraChatwoot(
    integracao: LoadedIntegration<'chatwoot'>,
    mensagem: MensagemRecebida,
  ): Promise<void> {
    const cliente = this.criarChatwoot(integracao.config)
    const numero = somenteDigitos(mensagem.chatId)

    const vinculo = await tentar(TENTATIVAS, async () => {
      const existente = await findLink(this.deps.db, integracao.row.id, mensagem.chatId)
      if (existente) return existente

      const contato = await cliente.garantirContato({
        identifier: numero,
        phoneNumber: `+${numero}`,
        name: integracao.config.fallbackName,
      })

      const conversationId = await cliente.criarConversa({
        sourceId: contato.sourceId,
        contactId: contato.contactId,
      })

      return upsertLink(this.deps.db, {
        integrationId: integracao.row.id,
        chatId: mensagem.chatId,
        externalConversationId: conversationId,
        externalContactId: String(contato.contactId),
      })
    })

    await tentar(TENTATIVAS, () =>
      cliente.criarMensagemRecebida({
        conversationId: vinculo.externalConversationId,
        content: mensagem.body ?? '',
        // The WhatsApp id travels along: it is what the webhook coming back
        // uses to recognise what came from here and not echo it straight back.
        sourceId: mensagem.engineMessageId,
      }),
    )
  }

  private async paraTypebot(
    integracao: LoadedIntegration<'typebot'>,
    mensagem: MensagemRecebida,
  ): Promise<void> {
    const texto = (mensagem.body ?? '').trim()
    const { humanHandoffKeyword, humanHandoffReply, sessionTtlMinutes } = integracao.config

    /**
     * The escape to a human comes before any call to the flow.
     *
     * Someone who types "agent" has already given up on the bot; sending the
     * message to the flow first would produce one more automated reply for
     * exactly the person who asked to stop receiving them.
     */
    if (humanHandoffKeyword && texto.toLowerCase() === humanHandoffKeyword.toLowerCase()) {
      await expireLink(this.deps.db, integracao.row.id, mensagem.chatId)
      if (humanHandoffReply) {
        await this.enfileirar(mensagem, integracao.row.id, [humanHandoffReply])
      }
      return
    }

    const cliente = this.criarTypebot(integracao.config)
    const vinculo = await findLink(this.deps.db, integracao.row.id, mensagem.chatId)

    let turno: Awaited<ReturnType<TypebotClient['iniciar']>>

    if (vinculo) {
      try {
        turno = await cliente.continuar(vinculo.externalConversationId, texto)
      } catch (erro) {
        // A dead session over there restarts, instead of stranding the contact.
        if (!(erro instanceof TypebotError) || !erro.sessaoExpirada) throw erro
        turno = await cliente.iniciar(texto)
      }
    } else {
      turno = await cliente.iniciar(texto)
    }

    if (turno.sessionId) {
      await upsertLink(this.deps.db, {
        integrationId: integracao.row.id,
        chatId: mensagem.chatId,
        externalConversationId: turno.sessionId,
        // A finished flow keeps no session: the next message starts over.
        expiresAt: turno.aguardandoResposta
          ? new Date(Date.now() + sessionTtlMinutes * 60_000)
          : new Date(),
      })
    }

    await this.enfileirar(mensagem, integracao.row.id, turno.textos)
  }

  /**
   * The escape hatch to any platform.
   *
   * Posts the event and sends back whatever the response carries. Unlike an
   * ordinary webhook, which tells you and forgets: here the response **is** the
   * message, and that is what lets an n8n flow or a serverless function be the
   * bot without anyone writing a dedicated connector in here.
   */
  private async paraHttp(
    integracao: LoadedIntegration<'http'>,
    mensagem: MensagemRecebida,
  ): Promise<void> {
    const conector = this.criarHttp(integracao.config)

    const resultado = await tentar(TENTATIVAS, () =>
      conector.enviar({
        event: 'message.received',
        data: {
          sessionId: mensagem.sessionId,
          messageId: mensagem.engineMessageId,
          chatId: mensagem.chatId,
          from: mensagem.fromJid,
          type: 'text',
          body: mensagem.body,
          timestamp: mensagem.occurredAt.toISOString(),
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
    if (resultado.diagnostico) {
      throw new Error(resultado.diagnostico)
    }

    await this.enfileirar(mensagem, integracao.row.id, resultado.replies)
  }

  /**
   * The replies enter through the same queue as any other send.
   *
   * That is the point of the arrangement: the flow's reply inherits
   * per-conversation ordering, the risk engine and redelivery. A Typebot wired
   * straight into Meta has none of that — it fires and hopes.
   */
  private async enfileirar(
    mensagem: MensagemRecebida,
    integrationId: string,
    textos: string[],
  ): Promise<void> {
    if (textos.length === 0) return

    const repo = new OutboxRepository(this.deps.db, mensagem.orgId)

    for (const [indice, texto] of textos.entries()) {
      await repo.enqueue({
        sessionId: mensagem.sessionId,
        chatId: mensagem.chatId,
        /**
         * The key ties the reply to the message that provoked it.
         *
         * If the same event is processed twice — engine redelivery, a restart
         * halfway through — the outbox recognises the duplicate and the
         * customer does not get the reply twice.
         */
        clientMessageId: `${integrationId}:${mensagem.engineMessageId}:${indice}`,
        type: 'text',
        payload: { text: texto },
        maxAttempts: this.deps.maxAttempts,
      })
    }
  }

  private criarChatwoot(config: ChatwootConfig): ChatwootClient {
    return this.deps.chatwootFactory?.(config) ?? new ChatwootClient(config)
  }

  private criarTypebot(config: TypebotConfig): TypebotClient {
    return this.deps.typebotFactory?.(config) ?? new TypebotClient(config)
  }

  private criarHttp(config: HttpConfig): HttpConnector {
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
async function tentar<T>(vezes: number, acao: () => Promise<T>): Promise<T> {
  let ultimo: unknown

  for (let i = 0; i < vezes; i++) {
    try {
      return await acao()
    } catch (erro) {
      ultimo = erro

      const permanente =
        (erro instanceof ChatwootError ||
          erro instanceof TypebotError ||
          erro instanceof HttpConnectorError) &&
        erro.isPermanente
      if (permanente || i === vezes - 1) break

      await new Promise((resolve) => setTimeout(resolve, ESPERA_BASE_MS * 2 ** i))
    }
  }

  throw ultimo
}

function somenteDigitos(chatId: string): string {
  return chatId.replace(/@.*$/, '').replace(/\D/g, '')
}
