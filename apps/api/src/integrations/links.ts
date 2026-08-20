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
 * O vínculo vivo entre uma conversa daqui e a mesma conversa lá fora.
 *
 * Vínculo vencido é tratado como inexistente, e não apagado: guardar o rastro
 * de qual sessão de fluxo atendeu qual conversa é o que permite explicar depois
 * por que o robô respondeu aquilo.
 */
export async function findLink(
  db: Database,
  integrationId: string,
  chatId: string,
): Promise<ConversationLink | null> {
  const [linha] = await db
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

  return linha ?? null
}

/** Caminho inverso: o webhook do Chatwoot chega com o id da conversa de lá. */
export async function findLinkByExternal(
  db: Database,
  integrationId: string,
  externalConversationId: string,
): Promise<ConversationLink | null> {
  const [linha] = await db
    .select(COLUMNS)
    .from(schema.integrationLinks)
    .where(
      and(
        eq(schema.integrationLinks.integrationId, integrationId),
        eq(schema.integrationLinks.externalConversationId, externalConversationId),
      ),
    )
    .limit(1)

  return linha ?? null
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
  const [linha] = await db
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

  if (!linha) throw new Error('failed to write the conversation link')
  return linha
}

/** Encerra a sessão de fluxo de um contato — o escape para atendimento humano. */
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
