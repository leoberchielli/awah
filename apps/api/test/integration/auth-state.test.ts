import { createDb, type Database, eq, schema } from '@awah/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { usePostgresAuthState } from '../../src/engines/baileys/auth-state'
import { createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL)
const encryptionKey = Buffer.from(
  process.env.ENCRYPTION_KEY ?? 'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  'base64',
)

describe.skipIf(!hasInfra)('auth state in Postgres', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database
  let org: SeededOrg
  let sessionId: string

  beforeAll(async () => {
    handle = createDb({ url: process.env.DATABASE_URL as string, max: 2 })
    db = handle.db
    org = await seedOrg(db)
    sessionId = await createSession(db, org.orgId)
  })

  afterAll(async () => {
    await org?.cleanup()
    await handle?.close()
  })

  it('starts with fresh credentials when the session has never paired', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    // initAuthCreds generates an identity pair; registration has not happened yet.
    expect(auth.state.creds.registered).toBe(false)
    expect(auth.state.creds.noiseKey).toBeDefined()
    expect(auth.isNew).toBe(true)
  })

  /**
   * `isNew` is what lets the manager write the identity before opening the
   * socket, closing the window where the user pairs and the process dies before
   * the first `creds.update` — leaving a ghost device on their phone.
   */
  it('stops being new once persisted', async () => {
    const otherSession = await createSession(db, org.orgId)
    const first = await usePostgresAuthState({ db, sessionId: otherSession, encryptionKey })
    expect(first.isNew).toBe(true)

    await first.saveCreds()

    const second = await usePostgresAuthState({ db, sessionId: otherSession, encryptionKey })
    expect(second.isNew).toBe(false)
  })

  it('persists and re-reads the credentials across instances', async () => {
    const first = await usePostgresAuthState({ db, sessionId, encryptionKey })
    first.state.creds.registered = true
    await first.saveCreds()

    // The second instance stands in for another replica taking over the session.
    const second = await usePostgresAuthState({ db, sessionId, encryptionKey })
    expect(second.state.creds.registered).toBe(true)
    expect(second.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private)
  })

  /**
   * The promise is that reading this table without the key takes over nobody's
   * WhatsApp. This test fails if anyone drops the cipher from the write path.
   */
  it('stores the credentials encrypted, not in the clear', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await auth.saveCreds()

    const [row] = await db
      .select({ creds: schema.sessionAuth.creds })
      .from(schema.sessionAuth)
      .where(eq(schema.sessionAuth.sessionId, sessionId))
      .limit(1)

    expect(row?.creds).toBeDefined()
    const stored = row?.creds ?? ''
    expect(stored).not.toContain('noiseKey')
    expect(stored).not.toContain('registered')
    // Format iv.tag.ciphertext.
    expect(stored.split('.')).toHaveLength(3)
  })

  it('round-trips the signal keys preserving Buffers', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })

    await auth.state.keys.set({
      'pre-key': {
        '1': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) },
      },
    })

    const fetched = await auth.state.keys.get('pre-key', ['1'])
    expect(Buffer.isBuffer(fetched['1']?.public)).toBe(true)
    expect(fetched['1']?.public).toEqual(Buffer.from([1, 2, 3]))
    expect(fetched['1']?.private).toEqual(Buffer.from([4, 5, 6]))
  })

  it('returns only the ids asked for', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await auth.state.keys.set({
      'pre-key': {
        '10': { public: Buffer.from([9]), private: Buffer.from([8]) },
        '11': { public: Buffer.from([7]), private: Buffer.from([6]) },
      },
    })

    const fetched = await auth.state.keys.get('pre-key', ['10'])
    expect(Object.keys(fetched)).toEqual(['10'])
  })

  /** Baileys calls get with an empty list; an empty inArray makes invalid SQL. */
  it('survives a get with an empty list', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await expect(auth.state.keys.get('pre-key', [])).resolves.toEqual({})
  })

  it('deletes the key when the value comes in null', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })

    await auth.state.keys.set({
      'pre-key': { '20': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    })
    expect(Object.keys(await auth.state.keys.get('pre-key', ['20']))).toHaveLength(1)

    await auth.state.keys.set({ 'pre-key': { '20': null } })
    expect(await auth.state.keys.get('pre-key', ['20'])).toEqual({})
  })

  it('separates keys of different types with the same id', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })

    await auth.state.keys.set({
      'pre-key': { '99': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    })
    await auth.state.keys.set({ session: { '99': Buffer.from([3, 3, 3]) } })

    const preKey = await auth.state.keys.get('pre-key', ['99'])
    const session = await auth.state.keys.get('session', ['99'])

    expect(preKey['99']).toBeDefined()
    expect(session['99']).toEqual(Buffer.from([3, 3, 3]))
  })

  it('clears credentials and keys on logout', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await auth.saveCreds()
    await auth.state.keys.set({
      'pre-key': { '30': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    })

    await auth.clear()

    const creds = await db
      .select({ id: schema.sessionAuth.sessionId })
      .from(schema.sessionAuth)
      .where(eq(schema.sessionAuth.sessionId, sessionId))
    const keys = await db
      .select({ id: schema.sessionAuthKeys.keyId })
      .from(schema.sessionAuthKeys)
      .where(eq(schema.sessionAuthKeys.sessionId, sessionId))

    expect(creds).toHaveLength(0)
    expect(keys).toHaveLength(0)
  })

  it('refuses the credentials when the encryption key is wrong', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await auth.saveCreds()

    const otherKey = Buffer.alloc(32, 7)
    await expect(usePostgresAuthState({ db, sessionId, encryptionKey: otherKey })).rejects.toThrow()
  })
})

describe.skipIf(!hasInfra)('changed encryption key', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database
  let org: SeededOrg

  beforeAll(async () => {
    handle = createDb({ url: process.env.DATABASE_URL as string, max: 2 })
    db = handle.db
    org = await seedOrg(db)
  })

  afterAll(async () => {
    await org?.cleanup()
    await handle?.close()
  })

  /**
   * The real case is ENCRYPTION_KEY rotation. Silently generating a new
   * identity would make the session ask to be paired again without saying why,
   * and the old device would be left hanging on the user's phone.
   */
  it('fails saying what happened instead of starting from scratch', async () => {
    const sessionId = await createSession(db, org.orgId)

    const original = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await original.saveCreds()

    await expect(
      usePostgresAuthState({ db, sessionId, encryptionKey: Buffer.alloc(32, 7) }),
    ).rejects.toThrow(/ENCRYPTION_KEY/)
  })
})
