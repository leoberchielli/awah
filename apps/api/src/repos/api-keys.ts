import { and, type DbExecutor, desc, eq, isNull, schema } from '@awah/db'
import type { Role } from '../auth/rbac'
import { TenantRepository } from './base'

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  role: Role
  sessionScope: string[] | null
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export interface ApiKeyLookup {
  id: string
  orgId: string
  secretHash: string
  role: Role
  sessionScope: string[] | null
  expiresAt: Date | null
  revokedAt: Date | null
}

export class ApiKeyRepository extends TenantRepository {
  async list(): Promise<ApiKeyRow[]> {
    return this.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        prefix: schema.apiKeys.prefix,
        role: schema.apiKeys.role,
        sessionScope: schema.apiKeys.sessionScope,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        expiresAt: schema.apiKeys.expiresAt,
        revokedAt: schema.apiKeys.revokedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, this.orgId))
      .orderBy(desc(schema.apiKeys.createdAt))
  }

  async create(input: {
    name: string
    prefix: string
    secretHash: string
    role: Role
    sessionScope?: string[] | null
    expiresAt?: Date | null
    createdByUserId?: string | null
  }): Promise<ApiKeyRow> {
    const [row] = await this.db
      .insert(schema.apiKeys)
      .values({
        orgId: this.orgId,
        name: input.name,
        prefix: input.prefix,
        secretHash: input.secretHash,
        role: input.role,
        sessionScope: input.sessionScope ?? null,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        prefix: schema.apiKeys.prefix,
        role: schema.apiKeys.role,
        sessionScope: schema.apiKeys.sessionScope,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        expiresAt: schema.apiKeys.expiresAt,
        revokedAt: schema.apiKeys.revokedAt,
        createdAt: schema.apiKeys.createdAt,
      })

    if (!row) throw new Error('falha ao criar chave de API')
    return row
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, id),
          eq(schema.apiKeys.orgId, this.orgId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning({ id: schema.apiKeys.id })

    return rows.length > 0
  }
}

/**
 * Busca por prefixo. Fica fora da classe de tenant de propósito: no momento da
 * autenticação ainda não sabemos a qual organização o pedido pertence — é
 * justamente a chave que informa isso.
 */
export async function findApiKeyByPrefix(
  db: DbExecutor,
  prefix: string,
): Promise<ApiKeyLookup | null> {
  const [row] = await db
    .select({
      id: schema.apiKeys.id,
      orgId: schema.apiKeys.orgId,
      secretHash: schema.apiKeys.secretHash,
      role: schema.apiKeys.role,
      sessionScope: schema.apiKeys.sessionScope,
      expiresAt: schema.apiKeys.expiresAt,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.prefix, prefix))
    .limit(1)

  return row ?? null
}

export async function touchApiKey(db: DbExecutor, id: string): Promise<void> {
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, id))
}
