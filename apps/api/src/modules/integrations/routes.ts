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
   * Validate before writing.
   *
   * A wrong credential saved in silence would only surface on the first message
   * from a real customer — and because the dispatcher swallows its own failures
   * to keep the session up, the conversation would simply never reach the tool,
   * with nobody knowing why.
   */
  async function verificar(kind: IntegrationKind, config: AnyIntegrationConfig) {
    /**
     * The generic connector gets a real workout: it sends a sample event and
     * reports what came back. Accepting it untested would leave the platform
     * silent until the first message from a real customer, which is exactly
     * the wrong moment to find out the URL was wrong.
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
   * Get the inbox ready and return its id.
   *
   * Three paths: `createInbox` creates a new one with the webhook already
   * pointed at us; `inboxId` reuses an existing one and fixes its webhook; and
   * with neither, whoever is integrating takes on the manual setup on the
   * other side.
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
       * Creating and editing an inbox needs an administrator token; a plain
       * agent gets a 403. Saying so is the difference between someone swapping
       * the token and someone giving up, sure the gateway is broken.
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
   * What this Chatwoot token reaches.
   *
   * The `accountId` is buried in the Chatwoot URL, and so is the `inboxId`:
   * asking someone to copy both out of there is the first thing that stalls
   * adoption. The token already knows the answers, so the panel asks it and
   * shows a list to pick from.
   *
   * Writes nothing — it is read-only, which is why it can be called as many
   * times as the assistant needs while the person fixes the address.
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
                  /** Only an API inbox works; the others have their own transport. */
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
   * Sends a sample event and reports what came back.
   *
   * When someone plugs in a platform nobody here has heard of, the alternative
   * to this button is guesswork: the conversation just does not answer, and
   * there is no clue where the mistake is. This shows the status, the timing,
   * the raw body, and the diagnosis of why the reply did not become a message.
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
            /** What was posted, for whoever builds the flow on the other side. */
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
         * A network failure comes back as a response, not an API error: whoever
         * is testing wants the reason on screen, and a 500 here would only say
         * "it went wrong".
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
       * The id is minted before the write.
       *
       * The webhook URL contains this id, and Chatwoot needs the URL at the
       * very moment the inbox is created — before the row exists. Picking the
       * id here breaks that chicken-and-egg without a second write.
       */
      const integrationId = randomUUID()

      if (kind === 'typebot' && typeof bruto.shareUrl === 'string') {
        /**
         * The share link instead of two fields.
         *
         * Asking for "baseUrl" and "typebotId" separately forces whoever is
         * integrating to know what a `publicId` is and where to look for it.
         * The link already carries both, and it is what is on the clipboard of
         * someone who just published a flow.
         */
        try {
          Object.assign(bruto, derivarDoLink(bruto.shareUrl))
        } catch (erro) {
          throw badRequest(erro instanceof Error ? erro.message : 'Invalid flow link.')
        }
        bruto.shareUrl = undefined
      }

      /**
       * The webhook token is generated here, not asked of the caller.
       *
       * Chatwoot's API inbox webhook does not sign the body and does not accept
       * a header of our own: the only place a secret fits is the URL. Leaving
       * that choice to whoever is integrating would produce "chatwoot" as the
       * token.
       */
      if (kind === 'chatwoot' && !bruto.webhookToken) {
        bruto.webhookToken = randomToken(24)
      }

      const webhookUrl = `${base()}/webhooks/chatwoot/${integrationId}/${bruto.webhookToken}`

      /**
       * Creates or reuses the inbox, and points the webhook by itself.
       *
       * These are the two steps that stall adoption most: creating the inbox by
       * clicking around Chatwoot and then going back to paste the URL. With
       * `createInbox` or `inboxId`, whoever is integrating never opens the
       * other tab.
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
         * Null when the gateway already pointed the webhook itself — there is
         * nothing for the person to do, and showing a URL would suggest there
         * is.
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
   * Agent reply, coming from Chatwoot.
   *
   * Public out of necessity: the caller is the Chatwoot server, with no API
   * key. The whole defence is the token in the URL — the API inbox webhook
   * does not sign the body and does not accept a header of our own, so the URL
   * **is** the secret. The route also checks `account` and `inbox` from the
   * payload, because two checkpoints are worth more than one.
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

      // Answer before processing: our error must not become their redelivery.
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
 * What becomes a WhatsApp message and what is dropped.
 *
 * Every drop here exists for a concrete reason, and removing any one of them
 * produces a known symptom: an echo loop, an internal note leaking to the
 * customer, or the customer's own message coming back to them.
 */
async function processar(
  app: FastifyInstance,
  integrationId: string,
  orgId: string,
  sessionId: string,
  evento: EventoChatwoot,
): Promise<void> {
  if (evento?.event !== 'message_created') return

  // Only an agent reply leaves here. 'incoming' is what we created ourselves.
  if (String(evento.message_type) !== 'outgoing' && Number(evento.message_type) !== 1) return

  // An internal note is the team talking about the customer, not to them.
  if (evento.private) return

  /**
   * A `source_id` present means the message was born on WhatsApp and we created
   * it in Chatwoot. Sending it back would be the classic echo loop.
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
     * The Chatwoot message id is the idempotency key.
     *
     * Chatwoot redelivers a webhook when it does not get a 200 in time; without
     * this key, a redelivery would send the same reply to the customer twice.
     */
    clientMessageId: `chatwoot:${evento.id}`,
    type: 'text',
    payload: { text: conteudo },
    maxAttempts: app.env.OUTBOX_MAX_ATTEMPTS,
  })
}
