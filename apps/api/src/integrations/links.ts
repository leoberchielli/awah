import { and, type Database, eq, gt, isNull, or, schema, sql } from '@awah/db'

export interface ConversationLink {
  id: string
  chatId: string
  externalConversationId: string
  externalContactId: string | null
  metadata: Record<string, unknown> | null
  expiresAt: Date | null
}

const COLUMNS = {
  id: schema.integrationLinks.id,
  chatId: schema.integrationLinks.chatId,
  externalConversationId: schema.integrationLinks.externalConversationId,
  externalContactId: schema.integrationLinks.externalContactId,
  metadata: schema.integrationLinks.metadata,
  expiresAt: schema.integrationLinks.expiresAt,
}

/**
 * The live link between a conversation here and the same one out there.
 *
 * An expired link is treated as non-existent, not deleted: keeping the trail of
 * which flow session handled which conversation is what lets us explain later
 * why the bot answered the way it did.
 */
export async function findLink(
  db: Database,
  integrationId: string,
  chatId: string,
): Promise<ConversationLink | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(schema.integrationLinks)
    .where(
      and(
        eq(schema.integrationLinks.integrationId, integrationId),
        eq(schema.integrationLinks.chatId, chatId),
        or(
          isNull(schema.integrationLinks.expiresAt),
          gt(schema.integrationLinks.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1)

  return row ?? null
}

/** Reverse path: the Chatwoot webhook arrives with their conversation id. */
export async function findLinkByExternal(
  db: Database,
  integrationId: string,
  externalConversationId: string,
): Promise<ConversationLink | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(schema.integrationLinks)
    .where(
      and(
        eq(schema.integrationLinks.integrationId, integrationId),
        eq(schema.integrationLinks.externalConversationId, externalConversationId),
      ),
    )
    .limit(1)

  return row ?? null
}

export async function upsertLink(
  db: Database,
  input: {
    integrationId: string
    chatId: string
    externalConversationId: string
    externalContactId?: string | null
    metadata?: Record<string, unknown> | null
    expiresAt?: Date | null
  },
): Promise<ConversationLink> {
  const [row] = await db
    .insert(schema.integrationLinks)
    .values({
      integrationId: input.integrationId,
      chatId: input.chatId,
      externalConversationId: input.externalConversationId,
      externalContactId: input.externalContactId ?? null,
      metadata: input.metadata ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.integrationLinks.integrationId, schema.integrationLinks.chatId],
      set: {
        externalConversationId: input.externalConversationId,
        externalContactId: input.externalContactId ?? null,
        metadata: input.metadata ?? null,
        expiresAt: input.expiresAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning(COLUMNS)

  if (!row) throw new Error('failed to write the conversation link')
  return row
}

/** Ends a contact's flow session — the escape to a human agent. */
export async function expireLink(
  db: Database,
  integrationId: string,
  chatId: string,
): Promise<void> {
  await db
    .update(schema.integrationLinks)
    .set({ expiresAt: sql`now()`, updatedAt: new Date() })
    .where(
      and(
        eq(schema.integrationLinks.integrationId, integrationId),
        eq(schema.integrationLinks.chatId, chatId),
      ),
    )
}
