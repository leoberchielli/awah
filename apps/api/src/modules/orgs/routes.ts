import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { hashPassword } from '../../auth/password'
import { requireAuth } from '../../auth/plugin'
import { can, ROLES } from '../../auth/rbac'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors'
import { IdentityRepository } from '../../repos/identity'
import { OrgRepository } from '../../repos/org'

const roleField = z.enum(ROLES)

const orgProfileSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  retentionDays: z.number(),
  createdAt: z.date(),
})

const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleField,
  joinedAt: z.date(),
})

export async function orgRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()
  const identity = new IdentityRepository(app.db)

  route.get(
    '/v1/org',
    {
      preHandler: app.requirePermission('org:read'),
      schema: {
        tags: ['organização'],
        summary: 'Ler a organização atual',
        response: { 200: orgProfileSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const org = await new OrgRepository(app.db, auth.orgId).profile()
      if (!org) throw notFound('Organização não encontrada.')
      return org
    },
  )

  route.patch(
    '/v1/org',
    {
      preHandler: app.requirePermission('org:update'),
      schema: {
        tags: ['organização'],
        summary: 'Atualizar a organização',
        description:
          'retentionDays controla por quantos dias o conteúdo de mensagem é preservado. 0 nunca persiste corpo, -1 retém para sempre.',
        body: z.object({
          name: z.string().min(2).max(120).optional(),
          retentionDays: z.number().int().min(-1).max(3650).optional(),
        }),
        response: { 200: orgProfileSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      if (Object.keys(request.body).length === 0) {
        throw badRequest('Informe pelo menos um campo para atualizar.')
      }

      const updated = await new OrgRepository(app.db, auth.orgId).update(request.body)
      if (!updated) throw notFound('Organização não encontrada.')
      return updated
    },
  )

  route.get(
    '/v1/org/members',
    {
      preHandler: app.requirePermission('member:read'),
      schema: {
        tags: ['organização'],
        summary: 'Listar membros',
        response: { 200: z.object({ members: z.array(memberSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const members = await new OrgRepository(app.db, auth.orgId).listMembers()
      return { members }
    },
  )

  /**
   * Adiciona um membro. Se o e-mail ainda não existe na instância, cria o
   * usuário com a senha informada — é o caminho de convite da onda 0. O fluxo
   * com e-mail de convite entra junto do dashboard.
   */
  route.post(
    '/v1/org/members',
    {
      preHandler: app.requirePermission('member:write'),
      schema: {
        tags: ['organização'],
        summary: 'Adicionar membro',
        body: z.object({
          email: z.string().email().max(254),
          role: roleField.default('viewer'),
          name: z.string().min(2).max(120).optional(),
          password: z.string().min(12).max(200).optional(),
        }),
        response: { 201: memberSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { email, role, name, password } = request.body

      if (role === 'owner' && !can(auth.role, 'member:set_owner')) {
        throw forbidden('Somente um owner promove outro owner.')
      }

      const orgs = new OrgRepository(app.db, auth.orgId)
      let user = await identity.findUserByEmail(email)

      if (!user) {
        if (!name || !password) {
          throw badRequest(
            'Este e-mail ainda não tem conta nesta instância. Informe name e password para criá-la.',
          )
        }
        const created = await identity.createUser({
          email,
          name,
          passwordHash: await hashPassword(password),
        })
        user = { id: created.id, email, name, passwordHash: '' }
      } else if (await identity.findMembership(auth.orgId, user.id)) {
        throw conflict('Este usuário já é membro da organização.')
      }

      await orgs.addMember(user.id, role)

      return reply.code(201).send({
        userId: user.id,
        email: user.email,
        name: user.name,
        role,
        joinedAt: new Date(),
      })
    },
  )

  route.patch(
    '/v1/org/members/:userId',
    {
      preHandler: app.requirePermission('member:write'),
      schema: {
        tags: ['organização'],
        summary: 'Alterar o papel de um membro',
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({ role: roleField }),
        response: { 200: z.object({ userId: z.string(), role: roleField }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { userId } = request.params
      const { role } = request.body

      if (role === 'owner' && !can(auth.role, 'member:set_owner')) {
        throw forbidden('Somente um owner promove outro owner.')
      }

      const orgs = new OrgRepository(app.db, auth.orgId)
      const current = await identity.findMembership(auth.orgId, userId)
      if (!current) throw notFound('Este usuário não é membro da organização.')

      // Rebaixar o último owner deixaria a org sem ninguém capaz de administrá-la.
      if (current === 'owner' && role !== 'owner' && (await orgs.ownerCount()) <= 1) {
        throw conflict('A organização precisa manter pelo menos um owner.')
      }

      const changed = await orgs.setRole(userId, role)
      if (!changed) throw notFound('Este usuário não é membro da organização.')

      return { userId, role }
    },
  )

  route.delete(
    '/v1/org/members/:userId',
    {
      preHandler: app.requirePermission('member:write'),
      schema: {
        tags: ['organização'],
        summary: 'Remover membro',
        params: z.object({ userId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { userId } = request.params
      const orgs = new OrgRepository(app.db, auth.orgId)

      const current = await identity.findMembership(auth.orgId, userId)
      if (!current) throw notFound('Este usuário não é membro da organização.')

      if (current === 'owner' && (await orgs.ownerCount()) <= 1) {
        throw conflict('A organização precisa manter pelo menos um owner.')
      }

      await orgs.removeMember(userId)
      return reply.code(204).send(null)
    },
  )
}
