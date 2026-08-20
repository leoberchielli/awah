import { randomUUID } from 'node:crypto'
import type { IntegrationKind } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { ChatwootClient, ChatwootError } from '../../integrations/chatwoot/client'
import {
  type AnyIntegrationConfig,
  type ChatwootConfig,
  deleteIntegration,
  findIntegrationById,
  type HttpConfig,
  httpConfigSchema,
  listIntegrations,
  parseConfig,
  saveIntegration,
  type TypebotConfig,
} from '../../integrations/config'
import {
  EVENTO_DE_TESTE,
  HttpConnector,
  HttpConnectorError,
} from '../../integrations/http/connector'
import { findLinkByExternal } from '../../integrations/links'
import { derivarDoLink, TypebotClient } from '../../integrations/typebot/client'
import { randomToken, safeEqual } from '../../lib/crypto'
import { badRequest, forbidden, notFound } from '../../lib/errors'
import { OutboxRepository } from '../../repos/outbox'
import { SessionRepository } from '../../repos/sessions'

const integrationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(['chatwoot', 'typebot', 'http']),
  active: z.boolean(),
  lastError: z.string().nullable().describe('Last failure talking to the tool.'),
  lastErrorAt: z.date().nullable(),
  createdAt: z.date(),
})

export async function integrationRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()
  const encryptionKey = Buffer.from(app.env.ENCRYPTION_KEY, 'base64')

  const base = () => app.env.PUBLIC_URL ?? `http://localhost:${app.env.PORT}`

  /**
   * Valida antes de gravar.
   *
   * Credencial errada guardada em silêncio só apareceria na primeira mensagem
   * de um cliente real — e como o dispatcher engole as próprias falhas para não
   * derrubar a sessão, a conversa simplesmente não chegaria na ferramenta, sem
   * ninguém saber por quê.
   */
  async function verificar(kind: IntegrationKind, config: AnyIntegrationConfig) {
    /**
     * O conector genérico é exercitado de verdade: manda um evento de exemplo e
     * conta o que voltou. Aceitar sem testar deixaria a plataforma calada até a
     * primeira mensagem de um cliente real, que é justamente a hora errada de
     * descobrir que a URL estava errada.
     */
    if (kind === 'http') {
      const resultado = await new HttpConnector(config as HttpConfig).enviar(EVENTO_DE_TESTE)

      if (resultado.diagnostico) {
        return {
          detail: `The platform answered ${resultado.status} in ${resultado.durationMs} ms, but nothing became a message: ${resultado.diagnostico}`,
        }
      }

      return {
        detail:
          resultado.replies.length > 0
            ? `Answered ${resultado.status} in ${resultado.durationMs} ms with ${resultado.replies.length} message(s).`
            : `Answered ${resultado.status} in ${resultado.durationMs} ms, with no message back — valid if you only want to record what arrives.`,
      }
    }

    if (kind === 'chatwoot') {
      const cliente = new ChatwootClient(config as ChatwootConfig)
      const inbox = await cliente.verificar()

      if (inbox.channelType !== 'Channel::Api') {
        throw badRequest(
          `Inbox ${(config as ChatwootConfig).inboxId} is of type "${inbox.channelType}". ` +
            'Only an API inbox works here: the others have their own transport and would ignore the gateway.',
        )
      }

      return { detail: `Inbox "${inbox.inboxName}" ready.` }
    }

    await new TypebotClient(config as TypebotConfig).verificar()
    return { detail: 'Flow reached and responding.' }
  }

  /**
   * Deixa a caixa pronta e devolve o id dela.
   *
   * Três caminhos: `createInbox` cria uma nova já com o webhook apontado;
   * `inboxId` reaproveita uma existente e corrige o webhook dela; e sem nenhum
   * dos dois, quem integra assume a configuração manual do outro lado.
   */
  async function prepararCaixa(
    bruto: Record<string, unknown>,
    webhookUrl: string,
  ): Promise<unknown> {
    const parcial = {
      baseUrl: String(bruto.baseUrl ?? ''),
      accountId: Number(bruto.accountId ?? 0),
      apiAccessToken: String(bruto.apiAccessToken ?? ''),
    }

    if (!parcial.baseUrl || !parcial.accountId || !parcial.apiAccessToken) {
      return bruto.inboxId
    }

    const cliente = new ChatwootClient(parcial as ChatwootConfig)

    try {
      if (typeof bruto.createInbox === 'string' && bruto.createInbox.trim()) {
        const criada = await cliente.criarCaixa(bruto.createInbox.trim(), webhookUrl)
        bruto.webhookConfigurado = true
        return criada.id
      }

      if (bruto.inboxId && bruto.apontarWebhook !== false) {
        await cliente.apontarWebhook(Number(bruto.inboxId), webhookUrl)
        bruto.webhookConfigurado = true
      }
    } catch (erro) {
      /**
       * Criar e editar caixa exige token de administrador; agente comum leva
       * 403. Dizer isso é a diferença entre a pessoa trocar o token e a pessoa
       * desistir achando que o gateway está quebrado.
       */
      if (erro instanceof ChatwootError && (erro.status === 401 || erro.status === 403)) {
        throw badRequest(
          'This token has no permission to create or edit inboxes. Use an administrator token, or create the API inbox in Chatwoot and paste the webhook URL by hand.',
        )
      }
      throw erro
    }

    return bruto.inboxId
  }

  route.get(
    '/v1/integrations',
    {
      preHandler: app.requirePermission('session:read'),
      schema: {
        tags: ['integrations'],
        summary: 'List integrations',
        description: 'Credentials are never returned — only the state and the last error.',
        response: { 200: z.object({ integrations: z.array(integrationSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      return { integrations: await listIntegrations(app.db, auth.orgId) }
    },
  )

  /**
   * O que este token do Chatwoot alcança.
   *
   * O `accountId` fica escondido na URL do Chatwoot e o `inboxId` também: pedir
   * que a pessoa copie os dois de lá é a primeira coisa que trava a adoção. O
   * token já sabe as respostas, então o painel pergunta a ele e mostra uma
   * lista para escolher.
   *
   * Não grava nada — é só leitura, e por isso pode ser chamada quantas vezes o
   * assistente precisar enquanto a pessoa corrige o endereço.
   */
  route.post(
    '/v1/integrations/chatwoot/discover',
    {
      preHandler: app.requirePermission('session:write'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['integrations'],
        summary: 'List Chatwoot accounts and inboxes',
        description:
          'Discovers what the token reaches so the dashboard does not have to ask for a typed accountId and inboxId.',
        body: z.object({
          baseUrl: z.string().url(),
          apiAccessToken: z.string().min(10),
          accountId: z.coerce
            .number()
            .int()
            .positive()
            .optional()
            .describe('Provide it to also receive the inboxes of this account.'),
        }),
        response: {
          200: z.object({
            accounts: z.array(z.object({ id: z.number(), name: z.string(), role: z.string() })),
            inboxes: z
              .array(
                z.object({
                  id: z.number(),
                  name: z.string(),
                  channelType: z.string(),
                  /** Só caixa do tipo API serve; as outras têm transporte próprio. */
                  usable: z.boolean(),
                }),
              )
              .nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { baseUrl, apiAccessToken, accountId } = request.body

      const cliente = new ChatwootClient({
        baseUrl: baseUrl.replace(/\/+$/, ''),
        accountId: accountId ?? 0,
        apiAccessToken,
      } as ChatwootConfig)

      let accounts: Awaited<ReturnType<ChatwootClient['contas']>>
      try {
        accounts = await cliente.contas()
      } catch (erro) {
        if (erro instanceof ChatwootError && erro.status === 401) {
          throw badRequest('Chatwoot rejected this token. Check that you copied the whole value.')
        }
        throw badRequest(
          erro instanceof Error
            ? `Could not reach Chatwoot: ${erro.message}`
            : 'Could not reach Chatwoot.',
        )
      }

      if (!accountId) return { accounts, inboxes: null }

      const caixas = await cliente.caixas()

      return {
        accounts,
        inboxes: caixas.map((caixa) => ({
          ...caixa,
          usable: caixa.channelType === 'Channel::Api',
        })),
      }
    },
  )

  /**
   * Manda um evento de exemplo e conta o que voltou.
   *
   * Quando alguém pluga uma plataforma que ninguém aqui conhece, a alternativa a
   * este botão é adivinhação: a conversa simplesmente não responde e não há
   * pista de onde está o engano. Aqui aparecem status, tempo, o corpo cru e o
   * diagnóstico de por que a resposta não virou mensagem.
   */
  route.post(
    '/v1/integrations/http/test',
    {
      preHandler: app.requirePermission('session:write'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['integrations'],
        summary: 'Test a connector URL',
        body: z.object({
          url: z.string().url(),
          secret: z.string().min(16).optional(),
          headers: z.record(z.string()).optional(),
          timeoutMs: z.coerce.number().int().min(500).max(30_000).optional(),
          replyPath: z.string().optional(),
        }),
        response: {
          200: z.object({
            ok: z.boolean(),
            status: z.number(),
            durationMs: z.number(),
            replies: z.array(z.string()),
            raw: z.string(),
            diagnostico: z.string().nullable(),
            /** O que foi postado, para quem está montando o fluxo do outro lado. */
            sentPayload: z.record(z.unknown()),
          }),
        },
      },
    },
    async (request) => {
      const config = httpConfigSchema.parse(request.body)

      try {
        const resultado = await new HttpConnector(config).enviar(EVENTO_DE_TESTE)

        return {
          ok: resultado.diagnostico === null,
          ...resultado,
          sentPayload: EVENTO_DE_TESTE as unknown as Record<string, unknown>,
        }
      } catch (erro) {
        /**
         * Falha de rede vira resposta, não erro da API: quem está testando quer
         * ver o motivo na tela, e um 500 aqui só diria "deu errado".
         */
        return {
          ok: false,
          status: erro instanceof HttpConnectorError ? erro.status : 0,
          durationMs: 0,
          replies: [],
          raw: '',
          diagnostico:
            erro instanceof Error
              ? erro.message
              : 'Could not reach that URL. Check that it is reachable from the gateway server.',
          sentPayload: EVENTO_DE_TESTE as unknown as Record<string, unknown>,
        }
      }
    },
  )

  route.put(
    '/v1/sessions/:id/integrations/:kind',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['integrations'],
        summary: 'Connect a tool to the session',
        description:
          'Tests the connection before saving. PUT because the set counts as a whole: a new token with the old inbox id is broken configuration, not partial.',
        params: z.object({ id: z.string().uuid(), kind: z.enum(['chatwoot', 'typebot', 'http']) }),
        body: z.record(z.unknown()),
        response: {
          200: z.object({
            integration: integrationSchema,
            detail: z.string(),
            webhookUrl: z
              .string()
              .nullable()
              .describe('Register it in Chatwoot, on the API inbox. Null for Typebot.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { id: sessionId, kind } = request.params

      const sessao = await new SessionRepository(app.db, auth.orgId).findById(sessionId)
      if (!sessao) throw notFound('Session not found.')

      const bruto = { ...request.body }

      /**
       * O id vem antes da gravação.
       *
       * A URL do webhook contém este id, e o Chatwoot precisa dela no mesmo
       * momento em que a caixa é criada — antes de a linha existir. Escolher o
       * id aqui quebra esse ovo-e-galinha sem uma segunda escrita.
       */
      const integrationId = randomUUID()

      if (kind === 'typebot' && typeof bruto.shareUrl === 'string') {
        /**
         * O link de compartilhamento no lugar de dois campos.
         *
         * Pedir "baseUrl" e "typebotId" separados obriga quem integra a saber o
         * que é `publicId` e onde procurá-lo. O link já traz os dois, e é o que
         * está na área de transferência de quem acabou de publicar um fluxo.
         */
        try {
          Object.assign(bruto, derivarDoLink(bruto.shareUrl))
        } catch (erro) {
          throw badRequest(erro instanceof Error ? erro.message : 'Invalid flow link.')
        }
        bruto.shareUrl = undefined
      }

      /**
       * O token do webhook é gerado aqui, não pedido a quem chama.
       *
       * O webhook de caixa API do Chatwoot não assina o corpo e não aceita
       * cabeçalho próprio: o único lugar onde cabe um segredo é a URL. Deixar
       * essa escolha com quem integra produziria "chatwoot" como token.
       */
      if (kind === 'chatwoot' && !bruto.webhookToken) {
        bruto.webhookToken = randomToken(24)
      }

      const webhookUrl = `${base()}/webhooks/chatwoot/${integrationId}/${bruto.webhookToken}`

      /**
       * Cria ou reaproveita a caixa, e aponta o webhook sozinho.
       *
       * São os dois passos que mais travam a adoção: criar a caixa clicando no
       * Chatwoot e depois voltar lá para colar a URL. Com `createInbox` ou
       * `inboxId`, quem integra não abre a outra aba.
       */
      if (kind === 'chatwoot') {
        bruto.inboxId = await prepararCaixa(bruto, webhookUrl)
      }

      const config = parseConfig(kind, bruto)
      const { detail } = await verificar(kind, config)

      const integration = await saveIntegration(app.db, encryptionKey, {
        id: integrationId,
        orgId: auth.orgId,
        sessionId,
        kind,
        config,
      })

      return reply.send({
        integration,
        detail,
        /**
         * Nulo quando o gateway já apontou o webhook sozinho — não há nada para
         * a pessoa fazer, e mostrar uma URL sugeriria que há.
         */
        webhookUrl:
          kind === 'chatwoot' && !bruto.webhookConfigurado
            ? `${base()}/webhooks/chatwoot/${integration.id}/${(config as ChatwootConfig).webhookToken}`
            : null,
      })
    },
  )

  route.delete(
    '/v1/integrations/:id',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['integrations'],
        summary: 'Disconnect the tool',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      if (!(await deleteIntegration(app.db, auth.orgId, request.params.id))) {
        throw notFound('Integration not found.')
      }
      return reply.code(204).send(null)
    },
  )

  /**
   * Resposta do agente, vinda do Chatwoot.
   *
   * Público por necessidade: quem chama é o servidor do Chatwoot, sem chave de
   * API. Toda a defesa está no token na URL — o webhook de caixa API não assina
   * o corpo e não aceita cabeçalho próprio, então a URL **é** o segredo. A rota
   * confere também `account` e `inbox` do payload, porque dois pontos de
   * conferência valem mais que um.
   */
  route.post(
    '/webhooks/chatwoot/:integrationId/:token',
    {
      schema: {
        tags: ['system'],
        summary: 'Agent reply from Chatwoot',
        hide: true,
        params: z.object({ integrationId: z.string().uuid(), token: z.string().min(10) }),
      },
    },
    async (request, reply) => {
      const { integrationId, token } = request.params

      const integracao = await findIntegrationById(app.db, integrationId, encryptionKey)
      if (integracao?.row.kind !== 'chatwoot') {
        throw notFound('Integration not found.')
      }

      const config = integracao.config as ChatwootConfig
      if (!safeEqual(token, config.webhookToken)) {
        throw forbidden('Invalid webhook token.')
      }

      const evento = request.body as EventoChatwoot

      if (evento?.account?.id !== undefined && Number(evento.account.id) !== config.accountId) {
        throw forbidden('Event from another Chatwoot account.')
      }

      // Responde antes de processar: erro nosso não deve virar reentrega deles.
      void processar(
        app,
        integracao.row.id,
        integracao.row.orgId,
        integracao.row.sessionId,
        evento,
      ).catch((erro) => {
        app.log.error({ err: erro, integrationId }, 'failed to process Chatwoot event')
      })

      return reply.send({ received: true })
    },
  )
}

interface EventoChatwoot {
  event?: string
  id?: number | string
  content?: string | null
  message_type?: string | number
  private?: boolean
  source_id?: string | null
  account?: { id?: number | string }
  inbox?: { id?: number | string }
  conversation?: { id?: number | string }
}

/**
 * O que vira mensagem no WhatsApp e o que é descartado.
 *
 * Cada descarte aqui existe por um motivo concreto, e tirar qualquer um deles
 * produz um sintoma conhecido: laço de eco, nota interna vazando para o
 * cliente, ou a própria mensagem do cliente voltando para ele.
 */
async function processar(
  app: FastifyInstance,
  integrationId: string,
  orgId: string,
  sessionId: string,
  evento: EventoChatwoot,
): Promise<void> {
  if (evento?.event !== 'message_created') return

  // Só resposta de agente sai daqui. 'incoming' é o que nós mesmos criamos.
  if (String(evento.message_type) !== 'outgoing' && Number(evento.message_type) !== 1) return

  // Nota interna é conversa da equipe sobre o cliente, não com ele.
  if (evento.private) return

  /**
   * `source_id` presente significa que a mensagem nasceu no WhatsApp e nós a
   * criamos no Chatwoot. Devolvê-la seria o laço de eco clássico.
   */
  if (evento.source_id) return

  const conteudo = (evento.content ?? '').trim()
  if (!conteudo) return

  const conversationId = evento.conversation?.id
  if (conversationId === undefined) return

  const vinculo = await findLinkByExternal(app.db, integrationId, String(conversationId))
  if (!vinculo) {
    app.log.warn(
      { integrationId, conversationId },
      'Chatwoot reply with no matching conversation in the gateway',
    )
    return
  }

  await new OutboxRepository(app.db, orgId).enqueue({
    sessionId,
    chatId: vinculo.chatId,
    /**
     * O id da mensagem no Chatwoot é a chave de idempotência.
     *
     * O Chatwoot reentrega webhook quando não recebe 200 a tempo; sem esta
     * chave, uma reentrega mandaria a mesma resposta duas vezes ao cliente.
     */
    clientMessageId: `chatwoot:${evento.id}`,
    type: 'text',
    payload: { text: conteudo },
    maxAttempts: app.env.OUTBOX_MAX_ATTEMPTS,
  })
}
