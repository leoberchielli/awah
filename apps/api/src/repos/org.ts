import { and, count, eq, schema } from '@awah/db'
import type { Role } from '../auth/rbac'
import { TenantRepository } from './base'

export interface OrgProfile {
  id: string
  slug: string
  name: string
  retentionDays: number
  createdAt: Date
}

export interface MemberRow {
  userId: string
  email: string
  name: string
  role: Role
  joinedAt: Date
}

/** Leitura e escrita da própria organização e do seu quadro de membros. */
export class OrgRepository extends TenantRepository {
  async profile(): Promise<OrgProfile | null> {
    const [row] = await this.db
      .select({
        id: schema.orgs.id,
        slug: schema.orgs.slug,
        name: schema.orgs.name,
        retentionDays: schema.orgs.retentionDays,
        createdAt: schema.orgs.createdAt,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, this.orgId))
      .limit(1)

    return row ?? null
  }

  async update(patch: { name?: string; retentionDays?: number }): Promise<OrgProfile | null> {
    const [row] = await this.db
      .update(schema.orgs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.orgs.id, this.orgId))
      .returning({
        id: schema.orgs.id,
        slug: schema.orgs.slug,
        name: schema.orgs.name,
        retentionDays: schema.orgs.retentionDays,
        createdAt: schema.orgs.createdAt,
      })

    return row ?? null
  }

  async listMembers(): Promise<MemberRow[]> {
    return this.db
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.memberships.role,
        joinedAt: schema.memberships.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.orgId, this.orgId))
  }

  async addMember(userId: string, role: Role): Promise<void> {
    await this.db
      .insert(schema.memberships)
      .values({ orgId: this.orgId, userId, role })
      .onConflictDoUpdate({
        target: [schema.memberships.orgId, schema.memberships.userId],
        set: { role, updatedAt: new Date() },
      })
  }

  async setRole(userId: string, role: Role): Promise<boolean> {
    const rows = await this.db
      .update(schema.memberships)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(schema.memberships.orgId, this.orgId), eq(schema.memberships.userId, userId)))
      .returning({ id: schema.memberships.id })

    return rows.length > 0
  }

  async removeMember(userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.memberships)
      .where(and(eq(schema.memberships.orgId, this.orgId), eq(schema.memberships.userId, userId)))
      .returning({ id: schema.memberships.id })

    return rows.length > 0
  }

  /**
   * Usado para impedir que a organização fique sem owner — rebaixar ou remover
   * o último owner deixaria a org sem ninguém capaz de administrá-la.
   */
  async ownerCount(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, this.orgId), eq(schema.memberships.role, 'owner')))

    return row?.value ?? 0
  }
}
