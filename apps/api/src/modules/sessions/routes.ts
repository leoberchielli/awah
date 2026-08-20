import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import QRCode from 'qrcode'
import { z } from 'zod'
import type { AuthContext } from '../../auth/plugin'
import { requireAuth } from '../../auth/plugin'
import { saveCloudApiCredentials } from '../../engines/cloud-api/credentials'
import { badRequest, conflict, notFound } from '../../lib/errors'
import { SessionRepository } from '../../repos/sessions'

const engineField = z.enum(['baileys', 'cloud_api', 'wwebjs', 'whatsmeow', 'simulator'])

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
  ownerNodeId: z.string().nullable().describe('Node holding the session now, by the active lease.'),
  pairedAt: z.date().nullable(),
  lastConnectedAt: z.date().nullable(),
  lastDisconnectedAt: z.date().nullable(),
  createdAt: z.date(),
  desiredState: z.enum(['running', 'stopped']).describe('Where the operator wants it to be.'),
  running: z.boolean().describe('Whether any node in the cluster holds the session now.'),
  runningHere: z.boolean().describe('Whether this node is the one holding it.'),
})

/**
 * An API key with `sessionScope` only sees the sessions listed in it.
 *
 * Outside the scope it answers 404, not 403: a 403 would confirm the session
 * exists, and a session's existence is already information the key should not
 * have.
 */
function assertInScope(auth: AuthContext, sessionId: string): void {
  if (auth.sessionScope && !auth.sessionScope.includes(sessionId)) {
    throw notFound('Session not found.')
  }
}

export async function sessionRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /**
   * `running` is a question about the cluster, not about this process: whoever
   * asks wants to know whether the session is up somewhere, and the load
   * balancer picks which replica answers.
   */
  const decorate = async <T extends { id: string; ownerNodeId: string | null }>(session: T) => {
    const owner = await app.sessions.ownerOf(session.id)
    return {
      ...session,
      /**
       * The owner comes from the lease, not from the column.
       *
       * The column holds the last node that took over, and it goes stale in
       * exactly the most confusing window: between the lease expiring and
       * another node adopting the session, it would point at a dead process.
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
        tags: ['sessions'],
        summary: 'Engine capability matrix',
        description:
          'What each engine supports. Engines not yet implemented appear with available=false.',
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
        ...(app.env.SIMULATOR_ENABLED
          ? [
              {
                engine: 'simulator' as const,
                available: true,
                capabilities: {
                  qrPairing: true,
                  codePairing: true,
                  groups: true,
                  channels: false,
                  presence: true,
                  reactions: true,
                  editMessage: true,
                  freeformMessaging: true,
                },
              },
            ]
          : []),
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
            // Outside the 24 h window, only a Meta-approved template.
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
        tags: ['sessions'],
        summary: 'Create session',
        description: 'Creates the record. The session only connects after START.',
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

      /*
       * The simulator is refused unless it was asked for at boot. Reaching it
       * by guessing the enum value would give an org a session that accepts
       * every send and reports it delivered without a phone involved.
       */
      if (request.body.engine === 'simulator' && !app.env.SIMULATOR_ENABLED) {
        throw badRequest(
          'The simulator engine is off. Start the instance with SIMULATOR_ENABLED=true to use it — never in production.',
        )
      }

      const existing = await repo.list()
      if (existing.some((s) => s.name === request.body.name)) {
        throw conflict('A session with this name already exists.')
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
        tags: ['sessions'],
        summary: 'List sessions',
        response: { 200: z.object({ sessions: z.array(sessionSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const rows = await new SessionRepository(app.db, auth.orgId).list(auth.sessionScope)

      // One ownership lookup for the whole list, instead of one per session.
      const owners = await app.sessions.ownersOf(rows.map((s) => s.id))

      return {
        sessions: rows.map((session) => ({
          ...session,
          ownerNodeId: owners.get(session.id) ?? null,
          running: owners.has(session.id),
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
        tags: ['sessions'],
        summary: 'Read session',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: sessionSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const session = await new SessionRepository(app.db, auth.orgId).findById(request.params.id)
      if (!session) throw notFound('Session not found.')
      return decorate(session)
    },
  )

  route.delete(
    '/v1/sessions/:id',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['sessions'],
        summary: 'Delete session',
        description: 'Disconnects before deleting. The credentials are erased along with it.',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const repo = new SessionRepository(app.db, auth.orgId)
      if (!(await repo.findById(request.params.id))) {
        throw notFound('Session not found.')
      }

      // Close the socket first; the database cascade takes credentials and events.
      await app.sessions.stopAnywhere(auth.orgId, request.params.id)
      await repo.remove(request.params.id)

      return reply.code(204).send(null)
    },
  )

  /**
   * Credentials for the official engine.
   *
   * PUT and not PATCH because the set only counts whole: a new token with the
   * old phoneNumberId is a broken configuration, not a partial one. The value
   * is encrypted before it touches the database and is never returned on read.
   */
  route.put(
    '/v1/sessions/:id/credentials',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['sessions'],
        summary: 'Configure Cloud API credentials',
        description:
          'Exclusive to the cloud_api engine. Stored encrypted, next to the auth state of the other engines — it is a credential, not configuration.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          phoneNumberId: z.string().min(5),
          accessToken: z.string().min(20),
          verifyToken: z.string().min(8).describe('Echoed back in the webhook handshake.'),
          appSecret: z
            .string()
            .min(8)
            .describe('Meta App Secret. It is what signs the body of the webhook events.'),
          graphVersion: z.string().default('v21.0'),
        }),
        response: {
          200: z.object({
            sessionId: z.string(),
            webhookUrl: z.string().describe('Register this URL in the Meta app.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const repo = new SessionRepository(app.db, auth.orgId)
      const session = await repo.findById(request.params.id)
      if (!session) throw notFound('Session not found.')

      if (session.engine !== 'cloud_api') {
        throw badRequest(
          `Credentials like these are exclusive to the cloud_api engine; this session uses "${session.engine}".`,
        )
      }

      await saveCloudApiCredentials(
        app.db,
        request.params.id,
        Buffer.from(app.env.ENCRYPTION_KEY, 'base64'),
        request.body,
      )

      /**
       * An absolute URL when the instance knows its own address.
       *
       * Meta registers a public HTTPS address; returning only the path would
       * force whoever integrates to assemble the URL by hand and to get the
       * host wrong whenever there is a proxy in front.
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
        tags: ['sessions'],
        summary: 'Start session',
        description:
          'Opens the connection. A new session enters pairing — fetch the QR at /qr or request a code at /pairing-code.',
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
        tags: ['sessions'],
        summary: 'Stop session',
        description:
          'Closes the connection while keeping the credentials — START reconnects without pairing.',
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
        tags: ['sessions'],
        summary: 'Log out on the phone',
        description:
          'Removes the device from the phone and erases the credentials. Coming back requires pairing again.',
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
        tags: ['sessions'],
        summary: 'Pairing QR',
        description:
          'Only exists during pairing and is swapped every few seconds. Returns 404 when no pairing is under way.',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            qr: z.string().describe('Raw content, to render however you prefer.'),
            image: z.string().describe('data: URI in PNG, ready for <img src>.'),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const qr = await app.sessions.currentQr(request.params.id)
      if (!qr) {
        throw notFound('No QR available. The session has to be started and waiting for pairing.')
      }

      return { qr, image: await QRCode.toDataURL(qr) }
    },
  )

  route.post(
    '/v1/sessions/:id/pairing-code',
    {
      preHandler: app.requirePermission('session:operate'),
      schema: {
        tags: ['sessions'],
        summary: 'Pairing code',
        description:
          'Alternative to the QR: generates an 8-character code to type on the phone. The session has to be started and not yet paired.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          phoneNumber: z
            .string()
            .min(10)
            .max(20)
            .describe('With country code, digits only. E.g.: 5511999999999'),
        }),
        response: { 200: z.object({ code: z.string() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      assertInScope(auth, request.params.id)

      const session = await new SessionRepository(app.db, auth.orgId).findById(request.params.id)
      if (!session) throw notFound('Session not found.')
      if (session.status === 'connected') {
        throw badRequest('This session is already paired.')
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
        tags: ['sessions'],
        summary: 'Connection timeline',
        description:
          'History of connections and drops, with the raw protocol code next to the translated cause.',
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
        throw notFound('Session not found.')
      }

      return { events: await repo.listEvents(request.params.id, request.query.limit) }
    },
  )
}
