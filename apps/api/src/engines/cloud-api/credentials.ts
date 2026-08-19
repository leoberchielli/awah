import { type Database, eq, schema } from '@awah/db'
import { z } from 'zod'
import { decrypt, encrypt } from '../../lib/crypto'
import { badRequest } from '../../lib/errors'

/**
 * Credenciais da Cloud API.
 *
 * Guardadas na mesma tabela cifrada do auth state do Baileys, e não em
 * `sessions.config`: o token de acesso permite enviar mensagem em nome da
 * empresa e ler as conversas dela — é credencial, não configuração. Reaproveitar
 * `session_auth` mantém a promessa de que nada disso fica legível para quem só
 * tem acesso de leitura ao banco.
 */
export const cloudApiCredentialsSchema = z.object({
  phoneNumberId: z.string().min(5).describe('ID do número no WhatsApp Business.'),
  accessToken: z.string().min(20).describe('Token permanente do app da Meta.'),
  /** Segredo que a Meta ecoa no handshake de verificação do webhook. */
  verifyToken: z.string().min(8),
  /**
   * App Secret da Meta. Obrigatório: é ele que assina o corpo dos eventos, e o
   * webhook é o único endpoint público do sistema. Sem assinatura para conferir,
   * qualquer um poderia injetar mensagens falsas na conta de qualquer cliente.
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
      'As credenciais da Cloud API estão ausentes ou corrompidas. Reconfigure-as em PUT /v1/sessions/:id/credentials.',
    )
  }
}
