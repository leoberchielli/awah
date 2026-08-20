import { type Database, eq, schema } from '@awah/db'
import { z } from 'zod'
import { decrypt, encrypt } from '../../lib/crypto'
import { badRequest } from '../../lib/errors'

/**
 * Cloud API credentials.
 *
 * Kept in the same encrypted table as the Baileys auth state, not in
 * `sessions.config`: the access token can send messages on the company's behalf
 * and read its chats — that is a credential, not configuration. Reusing
 * `session_auth` keeps the promise that none of it is readable to someone who
 * only has read access to the database.
 */
export const cloudApiCredentialsSchema = z.object({
  phoneNumberId: z.string().min(5).describe('Phone number ID in WhatsApp Business.'),
  accessToken: z.string().min(20).describe('Permanent token of the Meta app.'),
  /** The secret Meta echoes back in the webhook verification handshake. */
  verifyToken: z.string().min(8),
  /**
   * Meta's App Secret. Required: it is what signs the body of the events, and
   * the webhook is the only public endpoint in the system. With no signature to
   * check, anyone could inject fake messages into any customer's account.
   */
  appSecret: z.string().min(8),
  graphVersion: z.string().default('v21.0'),
})

export type CloudApiCredentials = z.infer<typeof cloudApiCredentialsSchema>

export async function saveCloudApiCredentials(
  db: Database,
  sessionId: string,
  encryptionKey: Buffer,
  credentials: CloudApiCredentials,
): Promise<void> {
  const payload = encrypt(JSON.stringify(credentials), encryptionKey)

  await db
    .insert(schema.sessionAuth)
    .values({ sessionId, creds: payload })
    .onConflictDoUpdate({
      target: schema.sessionAuth.sessionId,
      set: { creds: payload, updatedAt: new Date() },
    })
}

export async function clearCloudApiCredentials(db: Database, sessionId: string): Promise<void> {
  await db.delete(schema.sessionAuth).where(eq(schema.sessionAuth.sessionId, sessionId))
}

export async function loadCloudApiCredentials(
  db: Database,
  sessionId: string,
  encryptionKey: Buffer,
): Promise<CloudApiCredentials | null> {
  const [row] = await db
    .select({ creds: schema.sessionAuth.creds })
    .from(schema.sessionAuth)
    .where(eq(schema.sessionAuth.sessionId, sessionId))
    .limit(1)

  if (!row) return null

  try {
    return cloudApiCredentialsSchema.parse(JSON.parse(decrypt(row.creds, encryptionKey)))
  } catch {
    throw badRequest(
      'The Cloud API credentials are missing or corrupted. Set them again in PUT /v1/sessions/:id/credentials.',
    )
  }
}
