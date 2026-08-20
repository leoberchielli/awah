import { and, type Database, eq, type IntegrationKind, schema } from '@awah/db'
import { z } from 'zod'
import { decrypt, encrypt } from '../lib/crypto'
import { badRequest } from '../lib/errors'

/**
 * Credentials for the external tools.
 *
 * Encrypted for the same reason as the auth state: the Chatwoot token writes
 * into the customer's support account and reads every conversation in it. It is
 * a credential, not configuration, and read access to the database must not
 * reveal it.
 */
export const chatwootConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe('Address of the instance. https://app.chatwoot.com on the hosted version.')
    .transform((value) => value.replace(/\/+$/, '')),
  accountId: z.coerce.number().int().positive(),
  /** Must be an API-type inbox — the others carry their own transport. */
  inboxId: z.coerce.number().int().positive(),
  apiAccessToken: z.string().min(10).describe('Access token of the profile or of the agent bot.'),
  /**
   * The secret Chatwoot presents when it calls back.
   *
   * Chatwoot's API-inbox webhook does not sign the body and does not allow a
   * header of your own: the only place a secret fits is the URL itself. That is
   * why the URL is secret, and why the route also checks `account.id` and
   * `inbox.id` from the payload — two checkpoints are worth more than one.
   */
  webhookToken: z.string().min(24),
  /** Name shown on the contact when WhatsApp does not give the profile one. */
  fallbackName: z.string().min(1).default('WhatsApp contact'),
})

export const typebotConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe('https://typebot.io on the hosted version, or your own domain.')
    .transform((value) => value.replace(/\/+$/, '')),
  /** The flow's `publicId` — the same one that appears in the share URL. */
  typebotId: z.string().min(1),
  /** API token. Only needed when the flow is not public. */
  apiToken: z.string().min(10).optional(),
  /**
   * How much silence ends the flow session.
   *
   * Without an expiry, someone who wrote back three weeks later would land in
   * the middle of a form that no longer makes any sense.
   */
  sessionTtlMinutes: z.coerce.number().int().min(1).max(10_080).default(360),
  /**
   * What the customer types to escape the bot. Empty turns the escape off — do
   * that only if there is another route to a human.
   */
  humanHandoffKeyword: z.string().default('agent'),
  /** Reply to the escape, before the flow goes quiet for that contact. */
  humanHandoffReply: z.string().default('Got it — I am bringing in someone from the team.'),
})

/**
 * The connector for any platform.
 *
 * It exists so that plugging in a new tool does not depend on someone writing a
 * dedicated connector in here. Anything that accepts a POST and returns JSON
 * will do: n8n, Make, a serverless function, the in-house system.
 */
export const httpConfigSchema = z.object({
  url: z.string().url().describe('Where the gateway posts each incoming message.'),
  /**
   * Signs the body with HMAC-SHA256, the same scheme as the webhooks — anyone
   * who already validates an AWAH webhook validates this with the same
   * function. Optional because on a closed network it is weight for nothing;
   * in practice mandatory if the URL is public.
   */
  secret: z.string().min(16).optional(),
  /** Fixed headers. This is where the other side's auth token goes. */
  headers: z.record(z.string()).optional(),
  /**
   * Wait cap. It sits on the message path, so it is short on purpose: a
   * platform that takes 30 s to answer delays the whole queue for that
   * conversation.
   */
  timeoutMs: z.coerce.number().int().min(500).max(30_000).default(10_000),
  /** Dotted path to the reply, when it comes back nested. */
  replyPath: z.string().optional(),
  /** Label for the panel, to tell them apart when there is more than one. */
  label: z.string().min(1).default('External platform'),
})

export type ChatwootConfig = z.infer<typeof chatwootConfigSchema>
export type TypebotConfig = z.infer<typeof typebotConfigSchema>
export type HttpConfig = z.infer<typeof httpConfigSchema>
export type AnyIntegrationConfig = ChatwootConfig | TypebotConfig | HttpConfig

const SCHEMAS = {
  chatwoot: chatwootConfigSchema,
  typebot: typebotConfigSchema,
  http: httpConfigSchema,
} as const

export interface IntegrationRow {
  id: string
  orgId: string
  sessionId: string
  kind: IntegrationKind
  active: boolean
  lastError: string | null
  lastErrorAt: Date | null
  createdAt: Date
}

type ConfigDe<K extends IntegrationKind> = K extends 'chatwoot'
  ? ChatwootConfig
  : K extends 'typebot'
    ? TypebotConfig
    : HttpConfig

export interface LoadedIntegration<K extends IntegrationKind = IntegrationKind> {
  row: IntegrationRow
  config: ConfigDe<K>
}

const COLUMNS = {
  id: schema.integrations.id,
  orgId: schema.integrations.orgId,
  sessionId: schema.integrations.sessionId,
  kind: schema.integrations.kind,
  active: schema.integrations.active,
  lastError: schema.integrations.lastError,
  lastErrorAt: schema.integrations.lastErrorAt,
  createdAt: schema.integrations.createdAt,
}

export function parseConfig(kind: IntegrationKind, value: unknown): AnyIntegrationConfig {
  const result = SCHEMAS[kind].safeParse(value)

  if (!result.success) {
    throw badRequest(`Invalid configuration for ${kind}.`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  return result.data
}

export async function saveIntegration(
  db: Database,
  encryptionKey: Buffer,
  input: {
    orgId: string
    sessionId: string
    kind: IntegrationKind
    config: AnyIntegrationConfig
    active?: boolean
    /**
     * Id chosen from outside.
     *
     * Chatwoot needs the webhook URL — which contains this id — at the very
     * moment the inbox is created, before the row exists. Choosing the id up
     * front breaks that chicken-and-egg without a second write.
     */
    id?: string
  },
): Promise<IntegrationRow> {
  const encrypted = encrypt(JSON.stringify(input.config), encryptionKey)

  const [row] = await db
    .insert(schema.integrations)
    .values({
      ...(input.id ? { id: input.id } : {}),
      orgId: input.orgId,
      sessionId: input.sessionId,
      kind: input.kind,
      config: encrypted,
      active: input.active ?? true,
    })
    .onConflictDoUpdate({
      target: [schema.integrations.sessionId, schema.integrations.kind],
      set: {
        config: encrypted,
        active: input.active ?? true,
        // New configuration clears the old error: it was about what changed.
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      },
    })
    .returning(COLUMNS)

  if (!row) throw new Error('failed to write the integration')
  return row
}

/** A session's active integrations. This is the message-path query. */
export async function loadActiveIntegrations(
  db: Database,
  sessionId: string,
  encryptionKey: Buffer,
): Promise<LoadedIntegration[]> {
  const rows = await db
    .select({ ...COLUMNS, config: schema.integrations.config })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.sessionId, sessionId), eq(schema.integrations.active, true)))

  const loaded: LoadedIntegration[] = []

  for (const { config, ...row } of rows) {
    try {
      loaded.push({
        row,
        config: SCHEMAS[row.kind].parse(JSON.parse(decrypt(config, encryptionKey))) as never,
      })
    } catch {
      /**
       * An unreadable integration must not take down the others or the message.
       *
       * The real case is ENCRYPTION_KEY rotation. Whoever is operating will see
       * conversations stop arriving in the tool; the error is recorded on the
       * row so the panel can explain why.
       */
      await db
        .update(schema.integrations)
        .set({
          lastError:
            'Unreadable configuration: the current ENCRYPTION_KEY is not the one that wrote these credentials. Reconfigure the integration.',
          lastErrorAt: new Date(),
        })
        .where(eq(schema.integrations.id, row.id))
    }
  }

  return loaded
}

export async function listIntegrations(db: Database, orgId: string): Promise<IntegrationRow[]> {
  return db.select(COLUMNS).from(schema.integrations).where(eq(schema.integrations.orgId, orgId))
}

export async function findIntegrationById(
  db: Database,
  id: string,
  encryptionKey: Buffer,
): Promise<LoadedIntegration | null> {
  const [found] = await db
    .select({ ...COLUMNS, config: schema.integrations.config })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, id))
    .limit(1)

  if (!found) return null

  const { config, ...row } = found
  try {
    return {
      row,
      config: SCHEMAS[row.kind].parse(JSON.parse(decrypt(config, encryptionKey))) as never,
    }
  } catch {
    return null
  }
}

export async function deleteIntegration(db: Database, orgId: string, id: string): Promise<boolean> {
  const removidas = await db
    .delete(schema.integrations)
    .where(and(eq(schema.integrations.id, id), eq(schema.integrations.orgId, orgId)))
    .returning({ id: schema.integrations.id })

  return removidas.length > 0
}

/** Records the last failure so the panel can explain the silence. */
export async function recordIntegrationError(
  db: Database,
  integrationId: string,
  message: string,
): Promise<void> {
  await db
    .update(schema.integrations)
    .set({ lastError: message.slice(0, 500), lastErrorAt: new Date() })
    .where(eq(schema.integrations.id, integrationId))
}

export async function clearIntegrationError(db: Database, integrationId: string): Promise<void> {
  await db
    .update(schema.integrations)
    .set({ lastError: null, lastErrorAt: null })
    .where(eq(schema.integrations.id, integrationId))
}
