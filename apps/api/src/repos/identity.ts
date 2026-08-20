import { and, count, type Database, eq, gt, schema, sql } from '@awah/db'
import type { Role } from '../auth/rbac'

export interface UserRecord {
  id: string
  email: string
  name: string
  passwordHash: string
}

export interface MembershipRecord {
  orgId: string
  orgSlug: string
  orgName: string
  role: Role
}

/**
 * Identidade é global e vive fora do escopo de tenant: o mesmo usuário pode
 * pertencer a várias organizações com papéis diferentes. Por isso este
 * repositório não estende TenantRepository — a ligação com a org é a membership.
 */
export class IdentityRepository {
  constructor(private readonly db: Database) {}

  /** Usado para decidir se o registro de bootstrap ainda está aberto. */
  async organizationCount(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(schema.orgs)
    return row?.value ?? 0
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.email, normalizeEmail(email)))
      .limit(1)

    return row ?? null
  }

  /**
   * Cria organização, usuário e a membership de owner em uma transação. Os três
   * só fazem sentido juntos — org sem owner é órfã e usuário sem membership não
   * consegue entrar em lugar nenhum.
   */
  async createOrgWithOwner(input: {
    orgName: string
    orgSlug: string
    userName: string
    email: string
    passwordHash: string
  }): Promise<{ orgId: string; userId: string }> {
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(schema.orgs)
        .values({ name: input.orgName, slug: input.orgSlug })
        .returning({ id: schema.orgs.id })

      const [user] = await tx
        .insert(schema.users)
        .values({
          email: normalizeEmail(input.email),
          name: input.userName,
          passwordHash: input.passwordHash,
        })
        .returning({ id: schema.users.id })

      if (!org || !user) {
        throw new Error('failed to create organization and user')
      }

      await tx.insert(schema.memberships).values({
        orgId: org.id,
        userId: user.id,
        role: 'owner',
      })

      return { orgId: org.id, userId: user.id }
    })
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    const rows = await this.db
      .select({
        orgId: schema.orgs.id,
        orgSlug: schema.orgs.slug,
        orgName: schema.orgs.name,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.memberships.orgId))
      .where(eq(schema.memberships.userId, userId))

    return rows
  }

  async findMembership(orgId: string, userId: string): Promise<Role | null> {
    const [row] = await this.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
      .limit(1)

    return row?.role ?? null
  }

  async createSession(input: {
    userId: string
    tokenHash: string
    expiresAt: Date
    userAgent?: string | undefined
    ip?: string | undefined
  }): Promise<void> {
    await this.db.insert(schema.userSessions).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
  }

  /** Resolve a sessão do cookie. Sessão expirada é tratada como inexistente. */
  async findSessionUser(
    tokenHash: string,
  ): Promise<{ sessionId: string; userId: string; email: string; name: string } | null> {
    const [row] = await this.db
      .select({
        sessionId: schema.userSessions.id,
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.tokenHash, tokenHash),
          gt(schema.userSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)

    return row ?? null
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .update(schema.userSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.userSessions.id, sessionId))
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.delete(schema.userSessions).where(eq(schema.userSessions.tokenHash, tokenHash))
  }

  /** Remove sessões vencidas. Chamado por job periódico a partir da onda 5. */
  async purgeExpiredSessions(): Promise<number> {
    const result = await this.db
      .delete(schema.userSessions)
      .where(sql`${schema.userSessions.expiresAt} < now()`)
    return result.count ?? 0
  }

  async recordLogin(userId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
  }

  async createUser(input: {
    email: string
    name: string
    passwordHash: string
  }): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email: normalizeEmail(input.email),
        name: input.name,
        passwordHash: input.passwordHash,
      })
      .returning({ id: schema.users.id })

    if (!row) throw new Error('failed to create user')
    return row
  }
}

/** E-mail é sempre comparado e gravado em minúsculas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
