import { randomUUID } from 'node:crypto'
import { type Database, eq, schema } from '@awah/db'
import { generateApiKey } from '../../src/auth/api-key'
import type { Role } from '../../src/auth/rbac'
import { hashToken } from '../../src/lib/crypto'

export interface SeededOrg {
  orgId: string
  /** Token pronto para `Authorization: Bearer`. */
  token: string
  cleanup: () => Promise<void>
}

/**
 * Cria uma organização descartável com uma chave de API. Cada teste tem a sua,
 * para que a suíte não dependa de ordem nem de estado deixado por outro arquivo.
 */
export async function seedOrg(
  db: Database,
  options?: { role?: Role; sessionScope?: string[] | null },
): Promise<SeededOrg> {
  const suffix = randomUUID().slice(0, 8)

  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `Teste ${suffix}`, slug: `teste-${suffix}` })
    .returning({ id: schema.orgs.id })

  if (!org) throw new Error('falha ao criar organização de teste')

  const generated = generateApiKey()
  await db.insert(schema.apiKeys).values({
    orgId: org.id,
    name: `chave-${suffix}`,
    prefix: generated.prefix,
    secretHash: hashToken(generated.secret),
    role: options?.role ?? 'admin',
    sessionScope: options?.sessionScope ?? null,
  })

  return {
    orgId: org.id,
    token: generated.token,
    // Cascade leva sessões, chaves e eventos junto.
    cleanup: async () => {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, org.id))
    },
  }
}

/** Cria mais uma chave dentro de uma org existente, com papel e escopo próprios. */
export async function createApiKey(
  db: Database,
  orgId: string,
  options?: { role?: Role; sessionScope?: string[] | null },
): Promise<string> {
  const generated = generateApiKey()

  await db.insert(schema.apiKeys).values({
    orgId,
    name: `chave-${generated.prefix.slice(0, 6)}`,
    prefix: generated.prefix,
    secretHash: hashToken(generated.secret),
    role: options?.role ?? 'operator',
    sessionScope: options?.sessionScope ?? null,
  })

  return generated.token
}

export async function createSession(
  db: Database,
  orgId: string,
  name = `sessao-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const [row] = await db
    .insert(schema.sessions)
    .values({ orgId, name, engine: 'baileys' })
    .returning({ id: schema.sessions.id })

  if (!row) throw new Error('falha ao criar sessão de teste')
  return row.id
}
