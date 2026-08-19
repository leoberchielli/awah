import { createDb, type Database, eq, schema } from '@awah/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { usePostgresAuthState } from '../../src/engines/baileys/auth-state'
import { createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL)
const encryptionKey = Buffer.from(
  process.env.ENCRYPTION_KEY ?? 'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  'base64',
)

describe.skipIf(!hasInfra)('auth state no Postgres', () => {
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

  it('começa com credenciais novas quando a sessão nunca pareou', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    // initAuthCreds gera um par de identidade; o registro ainda não aconteceu.
    expect(auth.state.creds.registered).toBe(false)
    expect(auth.state.creds.noiseKey).toBeDefined()
    expect(auth.isNew).toBe(true)
  })

  /**
   * `isNew` é o que permite ao gerenciador gravar a identidade antes de abrir o
   * socket, fechando a janela em que o usuário pareia e o processo cai antes do
   * primeiro `creds.update` — deixando um dispositivo fantasma no aparelho.
   */
  it('deixa de ser nova depois de persistida', async () => {
    const outraSessao = await createSession(db, org.orgId)
    const primeira = await usePostgresAuthState({ db, sessionId: outraSessao, encryptionKey })
    expect(primeira.isNew).toBe(true)

    await primeira.saveCreds()

    const segunda = await usePostgresAuthState({ db, sessionId: outraSessao, encryptionKey })
    expect(segunda.isNew).toBe(false)
  })

  it('persiste e relê as credenciais entre instâncias', async () => {
    const first = await usePostgresAuthState({ db, sessionId, encryptionKey })
    first.state.creds.registered = true
    await first.saveCreds()

    // Segunda instância simula outra réplica assumindo a sessão.
    const second = await usePostgresAuthState({ db, sessionId, encryptionKey })
    expect(second.state.creds.registered).toBe(true)
    expect(second.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private)
  })

  /**
   * A promessa é que quem lê a tabela sem a chave não assume o WhatsApp de
   * ninguém. Este teste falha se alguém remover a cifra do caminho de escrita.
   */
  it('guarda as credenciais cifradas, não em claro', async () => {
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
    // Formato iv.tag.ciphertext.
    expect(stored.split('.')).toHaveLength(3)
  })

  it('faz round-trip das signal keys preservando Buffers', async () => {
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

  it('devolve apenas os ids pedidos', async () => {
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

  /** O Baileys chama get com lista vazia; inArray vazio geraria SQL inválido. */
  it('sobrevive a get com lista vazia', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await expect(auth.state.keys.get('pre-key', [])).resolves.toEqual({})
  })

  it('apaga a chave quando o valor vem nulo', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })

    await auth.state.keys.set({
      'pre-key': { '20': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    })
    expect(Object.keys(await auth.state.keys.get('pre-key', ['20']))).toHaveLength(1)

    await auth.state.keys.set({ 'pre-key': { '20': null } })
    expect(await auth.state.keys.get('pre-key', ['20'])).toEqual({})
  })

  it('separa chaves de tipos diferentes com o mesmo id', async () => {
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

  it('limpa credenciais e keys no logout', async () => {
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

  it('recusa credenciais quando a chave de cifra está errada', async () => {
    const auth = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await auth.saveCreds()

    const outraChave = Buffer.alloc(32, 7)
    await expect(
      usePostgresAuthState({ db, sessionId, encryptionKey: outraChave }),
    ).rejects.toThrow()
  })
})

describe.skipIf(!hasInfra)('chave de cifragem trocada', () => {
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
   * O caso real é rotação de ENCRYPTION_KEY. Gerar identidade nova em silêncio
   * faria a sessão pedir pareamento outra vez sem explicar por quê, e o
   * dispositivo antigo ficaria pendurado no aparelho do usuário.
   */
  it('falha dizendo o que aconteceu, em vez de começar do zero', async () => {
    const sessionId = await createSession(db, org.orgId)

    const original = await usePostgresAuthState({ db, sessionId, encryptionKey })
    await original.saveCreds()

    await expect(
      usePostgresAuthState({ db, sessionId, encryptionKey: Buffer.alloc(32, 7) }),
    ).rejects.toThrow(/ENCRYPTION_KEY/)
  })
})
