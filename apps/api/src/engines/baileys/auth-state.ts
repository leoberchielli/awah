import { and, type Database, eq, inArray, schema, sql } from '@awah/db'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from 'baileys'
import { BufferJSON, initAuthCreds, proto } from 'baileys'
import { decrypt, encrypt } from '../../lib/crypto'

export interface PostgresAuthState {
  state: AuthenticationState
  /** Persiste as credenciais. O Baileys chama isto no evento `creds.update`. */
  saveCreds: () => Promise<void>
  /** Apaga credenciais e keys. Usado no logout e na recuperação de sessão corrompida. */
  clear: () => Promise<void>
  /** true quando a identidade acabou de ser gerada e ainda não existia no banco. */
  isNew: boolean
}

export interface AuthStateDeps {
  db: Database
  sessionId: string
  encryptionKey: Buffer
}

/**
 * Auth state do Baileys sobre Postgres, cifrado em repouso.
 *
 * Esta função é a decisão que destrava o cluster inteiro (§4.4 da spec).
 * Enquanto o auth state vive em arquivo — como no `useMultiFileAuthState`
 * padrão — a sessão está presa ao disco de um nó específico, e failover deixa
 * de ser possível: outra réplica simplesmente não tem as credenciais.
 *
 * A cifra usa a mesma chave AES-256-GCM do resto do sistema. Quem obtiver
 * acesso de leitura ao banco, sem a chave, não consegue assumir o WhatsApp de
 * ninguém.
 */
export async function usePostgresAuthState(deps: AuthStateDeps): Promise<PostgresAuthState> {
  const { db, sessionId, encryptionKey } = deps

  const seal = (value: unknown): string =>
    encrypt(JSON.stringify(value, BufferJSON.replacer), encryptionKey)

  const open = <T>(payload: string): T =>
    JSON.parse(decrypt(payload, encryptionKey), BufferJSON.reviver) as T

  const [existing] = await db
    .select({ creds: schema.sessionAuth.creds })
    .from(schema.sessionAuth)
    .where(eq(schema.sessionAuth.sessionId, sessionId))
    .limit(1)

  /**
   * Credencial ilegível é erro, não motivo para começar do zero.
   *
   * O caso real é rotação de `ENCRYPTION_KEY`: o blob continua lá e deixa de
   * abrir. Gerar uma identidade nova em silêncio faria a sessão pedir pareamento
   * outra vez sem explicar por quê, e o dispositivo antigo ficaria pendurado no
   * aparelho. Melhor falhar dizendo exatamente o que aconteceu.
   */
  let creds: AuthenticationCreds
  if (existing) {
    try {
      creds = open<AuthenticationCreds>(existing.creds)
    } catch (error) {
      throw new Error(
        `Could not decrypt the auth state for session ${sessionId}. ` +
          'The current ENCRYPTION_KEY is not the one that wrote these credentials. ' +
          'Restore the previous key, or log the session out to pair again.',
        { cause: error },
      )
    }
  } else {
    creds = initAuthCreds()
  }

  const saveCreds = async (): Promise<void> => {
    const payload = seal(creds)
    await db
      .insert(schema.sessionAuth)
      .values({ sessionId, creds: payload })
      .onConflictDoUpdate({
        target: schema.sessionAuth.sessionId,
        set: { creds: payload, updatedAt: new Date() },
      })
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      async get(type, ids) {
        const result: Record<string, unknown> = {}
        // inArray com lista vazia gera SQL inválido — e o Baileys chama assim.
        if (ids.length === 0) return result as never

        const rows = await db
          .select({
            keyId: schema.sessionAuthKeys.keyId,
            value: schema.sessionAuthKeys.value,
          })
          .from(schema.sessionAuthKeys)
          .where(
            and(
              eq(schema.sessionAuthKeys.sessionId, sessionId),
              eq(schema.sessionAuthKeys.keyType, type),
              inArray(schema.sessionAuthKeys.keyId, ids),
            ),
          )

        for (const row of rows) {
          let value = open<unknown>(row.value)

          /**
           * O Baileys espera esta categoria como mensagem do protobuf, não como
           * objeto simples. Sem esta reidratação, a sincronização de app state
           * falha de um jeito silencioso e difícil de rastrear.
           */
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>)
          }

          result[row.keyId] = value
        }

        return result as never
      },

      async set(data) {
        const upserts: Array<{
          sessionId: string
          keyType: string
          keyId: string
          value: string
        }> = []
        /** Valor nulo no payload significa "esqueça esta chave". */
        const removals = new Map<string, string[]>()

        for (const rawType of Object.keys(data)) {
          const type = rawType as keyof SignalDataTypeMap
          const entries = data[type]
          if (!entries) continue

          for (const keyId of Object.keys(entries)) {
            const value = (entries as Record<string, unknown>)[keyId]

            if (value) {
              upserts.push({ sessionId, keyType: rawType, keyId, value: seal(value) })
            } else {
              const list = removals.get(rawType) ?? []
              list.push(keyId)
              removals.set(rawType, list)
            }
          }
        }

        if (upserts.length === 0 && removals.size === 0) return

        // Atômico: o store do Signal não pode ficar meio gravado.
        await db.transaction(async (tx) => {
          if (upserts.length > 0) {
            await tx
              .insert(schema.sessionAuthKeys)
              .values(upserts)
              .onConflictDoUpdate({
                target: [
                  schema.sessionAuthKeys.sessionId,
                  schema.sessionAuthKeys.keyType,
                  schema.sessionAuthKeys.keyId,
                ],
                set: {
                  value: sql`excluded.value`,
                  updatedAt: new Date(),
                },
              })
          }

          for (const [keyType, ids] of removals) {
            if (ids.length === 0) continue
            await tx
              .delete(schema.sessionAuthKeys)
              .where(
                and(
                  eq(schema.sessionAuthKeys.sessionId, sessionId),
                  eq(schema.sessionAuthKeys.keyType, keyType),
                  inArray(schema.sessionAuthKeys.keyId, ids),
                ),
              )
          }
        })
      },
    },
  }

  const clear = async (): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.delete(schema.sessionAuthKeys).where(eq(schema.sessionAuthKeys.sessionId, sessionId))
      await tx.delete(schema.sessionAuth).where(eq(schema.sessionAuth.sessionId, sessionId))
    })
  }

  return { state, saveCreds, clear, isNew: !existing }
}
