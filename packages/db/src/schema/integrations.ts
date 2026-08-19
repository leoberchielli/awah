import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { integrationKind } from './enums'
import { sessions } from './sessions'
import { orgs } from './tenancy'

/**
 * Ligação de uma sessão com uma ferramenta de fora.
 *
 * A escolha aqui é deliberada: em vez de construir caixa de entrada e
 * construtor de fluxo próprios, o AWAH é o transporte de quem já resolveu isso
 * bem. Chatwoot cuida do atendimento humano, Typebot cuida do fluxo — e o
 * gateway entrega o que nenhum dos dois tem, que é fila durável, ordem por
 * conversa e motor de risco embaixo.
 *
 * `config` é cifrado porque guarda token de API: quem o obtém escreve na conta
 * de atendimento do cliente.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: integrationKind('kind').notNull(),
    /** JSON cifrado em AES-256-GCM. Nunca devolvido em leitura. */
    config: text('config').notNull(),
    active: boolean('active').notNull().default(true),
    /** Última falha ao falar com a ferramenta, para o painel explicar o silêncio. */
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('integrations_org_idx').on(t.orgId),
    /**
     * Uma integração de cada tipo por sessão.
     *
     * Duas do mesmo tipo na mesma sessão duplicariam cada mensagem recebida na
     * ferramenta de destino, e o operador veria a conversa em dobro sem
     * entender por quê.
     */
    unique('integrations_session_kind_key').on(t.sessionId, t.kind),
  ],
)

/**
 * O vínculo entre uma conversa do WhatsApp e a mesma conversa lá fora.
 *
 * Sem esta tabela, cada mensagem recebida precisaria perguntar à ferramenta
 * "qual é o id desta conversa?" — uma chamada de rede a mais no caminho crítico
 * de toda mensagem, e um ponto de falha que colocaria a conversa em ordem
 * errada quando a API do outro lado estivesse lenta.
 *
 * `externalConversationId` guarda o id da conversa no Chatwoot ou a sessão do
 * fluxo no Typebot, conforme o tipo.
 */
export const integrationLinks = pgTable(
  'integration_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    /** JID do WhatsApp, do jeito que a engine entrega. */
    chatId: text('chat_id').notNull(),
    externalConversationId: text('external_conversation_id').notNull(),
    /** Contato no Chatwoot. Nulo no Typebot, que não tem esse conceito. */
    externalContactId: text('external_contact_id'),
    /** Espaço para o que cada conector precisar guardar por conversa. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /**
     * Sessão de fluxo expira; conversa de atendimento não. Nulo significa "não
     * expira".
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('integration_links_key').on(t.integrationId, t.chatId),
    index('integration_links_external_idx').on(t.integrationId, t.externalConversationId),
  ],
)
