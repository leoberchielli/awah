import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import QRCode from 'qrcode'
import { z } from 'zod'
import type { AuthContext } from '../../auth/plugin'
import { requireAuth } from '../../auth/plugin'
import { saveCloudApiCredentials } from '../../engines/cloud-api/credentials'
import { badRequest, conflict, notFound } from '../../lib/errors'
import { SessionRepository } from '../../repos/sessions'

const engineField = z.enum(['baileys', 'cloud_api', 'wwebjs', 'whatsmeow'])

const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: engineField,
  status: z.enum([
    'created',
    'pairing',
    'connecting',
    'connected',
    'disconnected',
    'logged_out',
    'banned',
  ]),
  phoneNumber: z.string().nullable(),
  ownerNodeId: z.string().nullable().describe('Nó que detém a sessão agora, pelo lease vigente.'),
  pairedAt: z.date().nullable(),
  lastConnectedAt: z.date().nullable(),
  lastDisconnectedAt: z.date().nullable(),
  createdAt: z.date(),
  desiredState: z.enum(['running', 'stopped']).describe('Onde o operador quer que ela esteja.'),
  running: z.boolean().describe('Se algum nó do cluster detém a sessão agora.'),
  runningHere: z.boolean().describe('Se é este nó que a detém.'),
})

/**
 * Uma chave de API com `sessionScope` só enxerga as sessões listadas nela.
 *
 * Fora do escopo responde 404, não 403: 403 confirmaria que a sessão existe,
 * e a existência de uma sessão já é informação que a chave não deveria ter.
 */
function assertInScope(auth: AuthContext, sessionId: string): void {
  if (auth.sessionScope && !auth.sessionScope.includes(sessionId)) {
    throw notFound('Sessão não encontrada.')
  }
}

export async function sessionRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /**
   * `running` é uma pergunta sobre o cluster, não sobre este processo: quem
   * consulta quer saber se a sessão está no ar em algum lugar, e o balanceador
   * escolhe a réplica que responde.
   */
  const decorate = async <T extends { id: string; ownerNodeId: string | null }>(session: T) => {
    const owner = await app.sessions.ownerOf(session.id)
    return {
      ...session,
      /**
       * O dono vem do lease, não da coluna.
       *
       * A coluna guarda o último nó que assumiu e fica velha justamente na
       * janela mais confusa: entre o lease expirar e outro nó adotar a sessão,
       * ela apontaria para um processo que já morreu.
       */
      ownerNodeId: owner,
      running: owner !== null,
      runningHere: app.sessions.isRunning(session.id),
    }
  }

  route.get(
    '/v1/engines',
    {
      preHandler: app.requirePermission('session:read'),
      schema: {
        tags: ['sessões'],
        summary: 'Matriz de capacidades das engines',
        description:
          'O que cada engine suporta. Engines ainda não implementadas aparecem com available=false.',
        response: {
          200: z.object({
            engines: z.array(
              z.object({
                engine: engineField,
                available: z.boolean(),
                capabilities: z.record(z.boolean()).nullable(),
              }),
            ),
          }),
        },
      },
    },
    async () => ({
      engines: [
        {
          engine: 'baileys' as const,
          available: true,
          capabilities: {
            qrPairing: true,
            codePairing: true,
            groups: true,
            channels: true,
            presence: true,
            reactions: true,
            editMessage: true,
            freeformMessaging: true,
          },
        },
        {
          engine: 'cloud_api' as const,
          available: true,
          capabilities: {
            qrPairing: false,
            codePairing: false,
            groups: false,
            channels: false,
            presence: false,
            reactions: true,
            editMessage: false,
            // Fora da janela de 24 h, só template aprovado pela Meta.
            freeformMessaging: false,
          },
        },
        { engine: 'wwebjs' as const, available: false, capabilities: null },
        { engine: 'whatsmeow' as const, available: false, capabilities: null },
      ],
    }),
  )

  route.post(
    '/v1/sessions',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['sessões'],
        summary: 'Criar sessão',
        description: 'Cria o registro. A sessão só conecta depois de START.',
        body: z.object({
          name: z.string().min(2).max(80),
          engine: engineField.default('baileys'),
        }),
        response: { 201: sessionSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const repo = new SessionRepository(app.db, auth.orgId)

      const existing = await repo.list()
      if (existing.some((s) => s.name === request.body.name)) {
        throw conflict('Já existe uma sessão com este nome.')
      }

      const created = await repo.create(request.body)
      return reply.code(201).send(await decorate(created))
    },
  )

  route.get(
    '/v1/sessions',
    {
      preHandler: app.requirePermission('session:read'),
      schema: {
        tags: ['sessões'],
        summary: 'Listar sessões',
        response: { 200: z.object({ sessions: z.array(sessionSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const rows = await new SessionRepository(app.db, auth.orgId).list(auth.sessionScope)

      // Uma consulta de posse para a lista inteira, em vez de uma por sessão.
      const donos = await app.sessions.ownersOf(rows.map((s) => s.id))

      return {
        sessions: rows.map((session) => ({
          ...session,
          ownerNodeId: donos.get(session.id) ?? null,
          running: donos.has(session.id),
          runningHere: app.sessions.isRunning(session.id),
        })),
      }
    },
  )

  route.get(
    '/v1/sessions/:id',
    {
      preHandler: app.requirePermission('session:read'),
      schema: {
        tags: ['sessões'],
        summary: 'Ler sessão',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: sessionSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const session = await new SessionRepository(app.db, auth.orgId).findById(request.params.id)
      if (!session) throw notFound('Sessão não encontrada.')
      return decorate(session)
    },
  )

  route.delete(
    '/v1/sessions/:id',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['sessões'],
        summary: 'Excluir sessão',
        description: 'Desconecta antes de excluir. As credenciais são apagadas junto.',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const repo = new SessionRepository(app.db, auth.orgId)
      if (!(await repo.findById(request.params.id))) {
        throw notFound('Sessão não encontrada.')
      }

      // Solta o socket antes; o cascade do banco leva credenciais e eventos.
      await app.sessions.stopAnywhere(auth.orgId, request.params.id)
      await repo.remove(request.params.id)

      return reply.code(204).send(null)
    },
  )

  /**
   * Credenciais da engine oficial.
   *
   * PUT e não PATCH porque o conjunto vale inteiro: um token novo com o
   * phoneNumberId antigo é uma configuração quebrada, não uma parcial. O valor
   * é cifrado antes de tocar o banco e nunca é devolvido em leitura.
   */
  route.put(
    '/v1/sessions/:id/credentials',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['sessões'],
        summary: 'Configurar credenciais da Cloud API',
        description:
          'Exclusivo da engine cloud_api. Guardado cifrado, junto do auth state das demais engines — é credencial, não configuração.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          phoneNumberId: z.string().min(5),
          accessToken: z.string().min(20),
          verifyToken: z.string().min(8).describe('Ecoado no handshake do webhook.'),
          appSecret: z
            .string()
            .min(8)
            .describe('App Secret da Meta. É o que assina o corpo dos eventos do webhook.'),
          graphVersion: z.string().default('v21.0'),
        }),
        response: {
          200: z.object({
            sessionId: z.string(),
            webhookUrl: z.string().describe('Cadastre esta URL no app da Meta.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const repo = new SessionRepository(app.db, auth.orgId)
      const session = await repo.findById(request.params.id)
      if (!session) throw notFound('Sessão não encontrada.')

      if (session.engine !== 'cloud_api') {
        throw badRequest(
          `Credenciais assim são exclusivas da engine cloud_api; esta sessão usa "${session.engine}".`,
        )
      }

      await saveCloudApiCredentials(
        app.db,
        request.params.id,
        Buffer.from(app.env.ENCRYPTION_KEY, 'base64'),
        request.body,
      )

      /**
       * URL absoluta quando a instância sabe o próprio endereço.
       *
       * A Meta cadastra um endereço público e HTTPS; devolver só o caminho
       * obrigaria quem integra a montar a URL na mão e a errar o host quando
       * houver proxy na frente.
       */
      const base = app.env.PUBLIC_URL ?? `http://localhost:${app.env.PORT}`

      return reply.send({
        sessionId: request.params.id,
        webhookUrl: `${base}/webhooks/meta/${request.params.id}`,
      })
    },
  )

  route.post(
    '/v1/sessions/:id/start',
    {
      preHandler: app.requirePermission('session:operate'),
      schema: {
        tags: ['sessões'],
        summary: 'Iniciar sessão',
        description:
          'Abre a conexão. Sessão nova entra em pareamento — busque o QR em /qr ou peça um código em /pairing-code.',
        params: z.object({ id: z.string().uuid() }),
        response: { 202: z.object({ id: z.string(), status: z.string() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      await app.sessions.start(auth.orgId, request.params.id)
      return reply.code(202).send({ id: request.params.id, status: 'connecting' })
    },
  )

  route.post(
    '/v1/sessions/:id/stop',
    {
      preHandler: app.requirePermission('session:operate'),
      schema: {
        tags: ['sessões'],
        summary: 'Parar sessão',
        description: 'Encerra a conexão preservando as credenciais — START reconecta sem parear.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ id: z.string(), status: z.string() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      await app.sessions.stopAnywhere(auth.orgId, request.params.id)
      return { id: request.params.id, status: 'disconnected' }
    },
  )

  route.post(
    '/v1/sessions/:id/logout',
    {
      preHandler: app.requirePermission('session:operate'),
      schema: {
        tags: ['sessões'],
        summary: 'Encerrar no aparelho',
        description:
          'Remove o dispositivo do aparelho e apaga as credenciais. Voltar exige parear de novo.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ id: z.string(), status: z.string() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      await app.sessions.stopAnywhere(auth.orgId, request.params.id, { logout: true })
      return { id: request.params.id, status: 'logged_out' }
    },
  )

  route.get(
    '/v1/sessions/:id/qr',
    {
      preHandler: app.requirePermission('session:operate'),
      schema: {
        tags: ['sessões'],
        summary: 'QR de pareamento',
        description:
          'Só existe durante o pareamento e é trocado a cada poucos segundos. Devolve 404 quando não há pareamento em curso.',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            qr: z.string().describe('Conteúdo cru, para renderizar como preferir.'),
            image: z.string().describe('data: URI em PNG, pronto para <img src>.'),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const qr = await app.sessions.currentQr(request.params.id)
      if (!qr) {
        throw notFound(
          'Nenhum QR disponível. A sessão precisa estar iniciada e aguardando pareamento.',
        )
      }

      return { qr, image: await QRCode.toDataURL(qr) }
    },
  )

  route.post(
    '/v1/sessions/:id/pairing-code',
    {
      preHandler: app.requirePermission('session:operate'),
      schema: {
        tags: ['sessões'],
        summary: 'Código de pareamento',
        description:
          'Alternativa ao QR: gera um código de 8 caracteres para digitar no aparelho. A sessão precisa estar iniciada e ainda não pareada.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          phoneNumber: z
            .string()
            .min(10)
            .max(20)
            .describe('Com código do país, só dígitos. Ex.: 5511999999999'),
        }),
        response: { 200: z.object({ code: z.string() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const session = await new SessionRepository(app.db, auth.orgId).findById(request.params.id)
      if (!session) throw notFound('Sessão não encontrada.')
      if (session.status === 'connected') {
        throw badRequest('Esta sessão já está pareada.')
      }

      const code = await app.sessions.requestPairingCodeAnywhere(
        auth.orgId,
        request.params.id,
        request.body.phoneNumber,
      )
      return { code }
    },
  )

  route.get(
    '/v1/sessions/:id/events',
    {
      preHandler: app.requirePermission('session:read'),
      schema: {
        tags: ['sessões'],
        summary: 'Timeline de conexão',
        description:
          'Histórico de conexão e queda, com o código bruto do protocolo ao lado da causa traduzida.',
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: {
          200: z.object({
            events: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                rawCode: z.number().nullable(),
                cause: z.string().nullable(),
                nodeId: z.string().nullable(),
                createdAt: z.date(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const repo = new SessionRepository(app.db, auth.orgId)
      if (!(await repo.findById(request.params.id))) {
        throw notFound('Sessão não encontrada.')
      }

      return { events: await repo.listEvents(request.params.id, request.query.limit) }
    },
  )
}
