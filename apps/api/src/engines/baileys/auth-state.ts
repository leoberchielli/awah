import { and, type Database, eq, inArray, schema, sql } from '@awah/db'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from 'baileys'
import { BufferJSON, initAuthCreds, proto } from 'baileys'
import { decrypt, encrypt } from '../../lib/crypto'

export interface PostgresAuthState {
  state: AuthenticationState
  /** Persists the credentials. Baileys calls this on the `creds.update` event. */
  saveCreds: () => Promise<void>
  /** Wipes credentials and keys. Used on logout and to recover a corrupted session. */
  clear: () => Promise<void>
  /** true when the identity was just generated and was not yet in the database. */
  isNew: boolean
}

export interface AuthStateDeps {
  db: Database
  sessionId: string
  encryptionKey: Buffer
}

/**
 * Baileys auth state on Postgres, encrypted at rest.
 *
 * This function is the decision that unlocks the whole cluster (§4.4 of the
 * spec). While the auth state lives in a file — as it does with the standard
 * `useMultiFileAuthState` — the session is tied to one specific node's disk,
 * and failover stops being possible: another replica simply does not have the
 * credentials.
 *
 * The cipher uses the same AES-256-GCM key as the rest of the system. Someone
 * who gets read access to the database, without the key, cannot take over
 * anyone's WhatsApp.
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
   * An unreadable credential is an error, not a reason to start from scratch.
   *
   * The real case is `ENCRYPTION_KEY` rotation: the blob is still there and
   * stops opening. Quietly generating a new identity would make the session ask
   * for pairing again without explaining why, and the old device would be left
   * hanging on the phone. Better to fail and say exactly what happened.
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
        // An empty list makes inArray emit invalid SQL — and Baileys passes one.
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
           * Baileys expects this category as a protobuf message, not a plain
           * object. Without this rehydration, app state sync fails in a way
           * that is silent and hard to track down.
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
        /** A null value in the payload means "forget this key". */
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

        // Atomic: the Signal store must not be left half-written.
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
