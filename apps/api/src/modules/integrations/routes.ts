import type { IntegrationKind } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { ChatwootClient } from '../../integrations/chatwoot/client'
import {
  type ChatwootConfig,
  deleteIntegration,
  findIntegrationById,
  listIntegrations,
  parseConfig,
  saveIntegration,
  type TypebotConfig,
} from '../../integrations/config'
import { findLinkByExternal } from '../../integrations/links'
import { TypebotClient } from '../../integrations/typebot/client'
import { randomToken, safeEqual } from '../../lib/crypto'
import { badRequest, forbidden, notFound } from '../../lib/errors'
import { OutboxRepository } from '../../repos/outbox'
import { SessionRepository } from '../../repos/sessions'

const integrationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(['chatwoot', 'typebot']),
  active: z.boolean(),
  lastError: z.string().nullable().describe('Última falha ao falar com a ferramenta.'),
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
  async function verificar(kind: IntegrationKind, config: ChatwootConfig | TypebotConfig) {
    if (kind === 'chatwoot') {
      const cliente = new ChatwootClient(config as ChatwootConfig)
      const inbox = await cliente.verificar()

      if (inbox.channelType !== 'Channel::Api') {
        throw badRequest(
          `A caixa ${(config as ChatwootConfig).inboxId} é do tipo "${inbox.channelType}". ` +
            'Só uma caixa do tipo API funciona aqui: as demais têm transporte próprio e ignorariam o gateway.',
        )
      }

      return { detail: `Caixa "${inbox.inboxName}" pronta.` }
    }

    await new TypebotClient(config as TypebotConfig).verificar()
    return { detail: 'Fluxo alcançado e respondendo.' }
  }

  route.get(
    '/v1/integrations',
    {
      preHandler: app.requirePermission('session:read'),
      schema: {
        tags: ['integrações'],
        summary: 'Listar integrações',
        description: 'As credenciais nunca são devolvidas — só o estado e o último erro.',
        response: { 200: z.object({ integrations: z.array(integrationSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      return { integrations: await listIntegrations(app.db, auth.orgId) }
    },
  )

  route.put(
    '/v1/sessions/:id/integrations/:kind',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['integrações'],
        summary: 'Ligar uma ferramenta à sessão',
        description:
          'Testa a conexão antes de gravar. PUT porque o conjunto vale inteiro: um token novo com o id de caixa antigo é configuração quebrada, não parcial.',
        params: z.object({ id: z.string().uuid(), kind: z.enum(['chatwoot', 'typebot']) }),
        body: z.record(z.unknown()),
        response: {
          200: z.object({
            integration: integrationSchema,
            detail: z.string(),
            webhookUrl: z
              .string()
              .nullable()
              .describe('Cadastre no Chatwoot, na caixa API. Nulo para o Typebot.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { id: sessionId, kind } = request.params

      const sessao = await new SessionRepository(app.db, auth.orgId).findById(sessionId)
      if (!sessao) throw notFound('Sessão não encontrada.')

      const bruto = { ...request.body }

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

      const config = parseConfig(kind, bruto)
      const { detail } = await verificar(kind, config)

      const integration = await saveIntegration(app.db, encryptionKey, {
        orgId: auth.orgId,
        sessionId,
        kind,
        config,
      })

      return reply.send({
        integration,
        detail,
        webhookUrl:
          kind === 'chatwoot'
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
        tags: ['integrações'],
        summary: 'Desligar a ferramenta',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      if (!(await deleteIntegration(app.db, auth.orgId, request.params.id))) {
        throw notFound('Integração não encontrada.')
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
        tags: ['sistema'],
        summary: 'Resposta do agente no Chatwoot',
        hide: true,
        params: z.object({ integrationId: z.string().uuid(), token: z.string().min(10) }),
      },
    },
    async (request, reply) => {
      const { integrationId, token } = request.params

      const integracao = await findIntegrationById(app.db, integrationId, encryptionKey)
      if (integracao?.row.kind !== 'chatwoot') {
        throw notFound('Integração não encontrada.')
      }

      const config = integracao.config as ChatwootConfig
      if (!safeEqual(token, config.webhookToken)) {
        throw forbidden('Token do webhook inválido.')
      }

      const evento = request.body as EventoChatwoot

      if (evento?.account?.id !== undefined && Number(evento.account.id) !== config.accountId) {
        throw forbidden('Evento de outra conta do Chatwoot.')
      }

      // Responde antes de processar: erro nosso não deve virar reentrega deles.
      void processar(
        app,
        integracao.row.id,
        integracao.row.orgId,
        integracao.row.sessionId,
        evento,
      ).catch((erro) => {
        app.log.error({ err: erro, integrationId }, 'falha ao processar evento do Chatwoot')
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
      'resposta do Chatwoot sem conversa correspondente no gateway',
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
