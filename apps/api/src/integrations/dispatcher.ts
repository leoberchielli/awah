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
  /** Injetáveis para teste. */
  chatwootFactory?: (config: ChatwootConfig) => ChatwootClient
  typebotFactory?: (config: TypebotConfig) => TypebotClient
  httpFactory?: (config: HttpConfig) => HttpConnector
}

/** Três tentativas em ~7 s cobrem o reinício de um contêiner do outro lado. */
const TENTATIVAS = 3
const ESPERA_BASE_MS = 500

/**
 * Leva o que chega do WhatsApp para as ferramentas ligadas à sessão.
 *
 * A decisão de arquitetura por trás disto: em vez de construir caixa de entrada
 * e construtor de fluxo próprios, o AWAH é o transporte de quem já resolveu bem
 * essas duas coisas. O que ele acrescenta — fila durável, ordem por conversa,
 * motor de risco — é justamente o que falta a elas, e é a razão de valer a pena
 * pôr o gateway embaixo em vez de ligar o Chatwoot direto na Meta.
 */
export class IntegrationDispatcher {
  constructor(private readonly deps: IntegrationDispatcherDeps) {}

  /**
   * Nunca deixa uma falha escapar.
   *
   * Este método roda no caminho da mensagem que chega da engine; uma exceção
   * aqui derrubaria o tratamento do evento e, no limite, a conexão do WhatsApp.
   * Ferramenta externa fora do ar é um problema dela, não da sessão.
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
        'falha ao carregar integrações',
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
        const texto = erro instanceof Error ? erro.message : 'falha desconhecida'

        this.deps.logger.error(
          { err: erro, integrationId: integracao.row.id, kind: integracao.row.kind },
          'integração falhou ao processar mensagem recebida',
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
        // O id do WhatsApp viaja junto: é o que o webhook de volta usa para
        // reconhecer o que veio daqui e não devolver em eco.
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
     * O escape para o humano vem antes de qualquer chamada ao fluxo.
     *
     * Quem digita "atendente" já desistiu do robô; mandar a mensagem para o
     * fluxo primeiro produziria mais uma resposta automática justamente para
     * quem pediu para parar de recebê-las.
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
        // Sessão que morreu do outro lado recomeça, em vez de calar o contato.
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
        // Fluxo encerrado não guarda sessão: a próxima mensagem começa do zero.
        expiresAt: turno.aguardandoResposta
          ? new Date(Date.now() + sessionTtlMinutes * 60_000)
          : new Date(),
      })
    }

    await this.enfileirar(mensagem, integracao.row.id, turno.textos)
  }

  /**
   * O escape para qualquer plataforma.
   *
   * Posta o evento e envia de volta o que a resposta trouxer. Diferente de um
   * webhook comum, que avisa e esquece: aqui a resposta **é** a mensagem, e é
   * isso que permite a um fluxo do n8n ou a uma função serverless ser o robô
   * sem que ninguém escreva um conector dedicado aqui dentro.
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
     * Resposta que não virou mensagem é registrada como erro, não engolida.
     *
     * Silêncio aqui é o pior resultado possível: quem acabou de plugar uma
     * plataforma nova ficaria olhando para uma conversa parada sem nenhuma
     * pista de que o formato da resposta estava errado.
     */
    if (resultado.diagnostico) {
      throw new Error(resultado.diagnostico)
    }

    await this.enfileirar(mensagem, integracao.row.id, resultado.replies)
  }

  /**
   * As respostas entram pela mesma fila de qualquer outro envio.
   *
   * É o ponto do arranjo: a resposta do fluxo herda ordem por conversa, motor de
   * risco e reentrega. Um Typebot ligado direto na Meta não tem nada disso — ele
   * dispara e torce.
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
         * A chave amarra a resposta à mensagem que a provocou.
         *
         * Se o mesmo evento for processado duas vezes — reentrega da engine,
         * reinício no meio —, o outbox reconhece a duplicata e o cliente não
         * recebe a resposta em dobro.
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
 * Repete só o que vale repetir.
 *
 * Erro 4xx do outro lado é configuração errada — token inválido, caixa que não
 * existe. Repetir produz a mesma recusa três vezes e atrasa o registro do erro
 * que o operador precisa ver.
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
