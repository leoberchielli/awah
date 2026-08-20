import { randomUUID } from 'node:crypto'
import { type Database, eq, schema } from '@awah/db'
import { generateApiKey } from '../../src/auth/api-key'
import { hashPassword } from '../../src/auth/password'
import type { Role } from '../../src/auth/rbac'
import { hashToken } from '../../src/lib/crypto'

export interface SeededOrg {
  orgId: string
  /** Token ready to drop into `Authorization: Bearer`. */
  token: string
  cleanup: () => Promise<void>
}

/**
 * Creates a throwaway org with one API key. Every test gets its own, so the
 * suite never depends on ordering or on state another file left behind.
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

  if (!org) throw new Error('failed to create the test organization')

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
    // Cascade takes the sessions, keys and events with it.
    cleanup: async () => {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, org.id))
    },
  }
}

export interface SeededUser {
  email: string
  password: string
  userId: string
}

/**
 * Creates a user with a known password inside an existing org.
 *
 * It exists because an API key does not administer identity — issuing a key,
 * promoting a member and changing the org all need a user session, by design.
 * Testing those routes means going through a real login.
 */
export async function seedUser(
  db: Database,
  orgId: string,
  options?: { role?: Role },
): Promise<SeededUser> {
  const suffix = randomUUID().slice(0, 8)
  const email = `test-${suffix}@example.invalid`
  const password = `senha-de-teste-${suffix}`

  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      name: `Teste ${suffix}`,
      passwordHash: await hashPassword(password),
    })
    .returning({ id: schema.users.id })

  if (!user) throw new Error('failed to create the test user')

  await db.insert(schema.memberships).values({
    orgId,
    userId: user.id,
    role: options?.role ?? 'owner',
  })

  return { email, password, userId: user.id }
}

/** Creates one more key inside an existing org, with its own role and scope. */
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

  if (!row) throw new Error('failed to create the test session')
  return row.id
}
