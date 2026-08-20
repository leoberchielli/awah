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
        tags: ['organization'],
        summary: 'Read the current organization',
        response: { 200: orgProfileSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const org = await new OrgRepository(app.db, auth.orgId).profile()
      if (!org) throw notFound('Organization not found.')
      return org
    },
  )

  route.patch(
    '/v1/org',
    {
      preHandler: app.requirePermission('org:update'),
      schema: {
        tags: ['organization'],
        summary: 'Update the organization',
        description:
          'retentionDays controls how many days message content is kept. 0 never persists the body, -1 keeps it forever.',
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
        throw badRequest('Provide at least one field to update.')
      }

      const updated = await new OrgRepository(app.db, auth.orgId).update(request.body)
      if (!updated) throw notFound('Organization not found.')
      return updated
    },
  )

  route.get(
    '/v1/org/members',
    {
      preHandler: app.requirePermission('member:read'),
      schema: {
        tags: ['organization'],
        summary: 'List members',
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
        tags: ['organization'],
        summary: 'Add member',
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
        throw forbidden('Only an owner promotes another owner.')
      }

      const orgs = new OrgRepository(app.db, auth.orgId)
      let user = await identity.findUserByEmail(email)

      if (!user) {
        if (!name || !password) {
          throw badRequest(
            'This email has no account on this instance yet. Provide name and password to create one.',
          )
        }
        const created = await identity.createUser({
          email,
          name,
          passwordHash: await hashPassword(password),
        })
        user = { id: created.id, email, name, passwordHash: '' }
      } else if (await identity.findMembership(auth.orgId, user.id)) {
        throw conflict('This user is already a member of the organization.')
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
        tags: ['organization'],
        summary: 'Change a member role',
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
        throw forbidden('Only an owner promotes another owner.')
      }

      const orgs = new OrgRepository(app.db, auth.orgId)
      const current = await identity.findMembership(auth.orgId, userId)
      if (!current) throw notFound('This user is not a member of the organization.')

      // Rebaixar o último owner deixaria a org sem ninguém capaz de administrá-la.
      if (current === 'owner' && role !== 'owner' && (await orgs.ownerCount()) <= 1) {
        throw conflict('The organization must keep at least one owner.')
      }

      const changed = await orgs.setRole(userId, role)
      if (!changed) throw notFound('This user is not a member of the organization.')

      return { userId, role }
    },
  )

  route.delete(
    '/v1/org/members/:userId',
    {
      preHandler: app.requirePermission('member:write'),
      schema: {
        tags: ['organization'],
        summary: 'Remove member',
        params: z.object({ userId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { userId } = request.params
      const orgs = new OrgRepository(app.db, auth.orgId)

      const current = await identity.findMembership(auth.orgId, userId)
      if (!current) throw notFound('This user is not a member of the organization.')

      if (current === 'owner' && (await orgs.ownerCount()) <= 1) {
        throw conflict('The organization must keep at least one owner.')
      }

      await orgs.removeMember(userId)
      return reply.code(204).send(null)
    },
  )
}
