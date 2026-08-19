import { and, type Database, eq, type IntegrationKind, schema } from '@awah/db'
import { z } from 'zod'
import { decrypt, encrypt } from '../lib/crypto'
import { badRequest } from '../lib/errors'

/**
 * Credenciais das ferramentas externas.
 *
 * Cifradas pelo mesmo motivo do auth state: o token do Chatwoot escreve na
 * conta de atendimento do cliente e lê todas as conversas dela. É credencial,
 * não configuração, e acesso de leitura ao banco não deve revelá-la.
 */
export const chatwootConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe('Endereço da instância. https://app.chatwoot.com na versão hospedada.')
    .transform((valor) => valor.replace(/\/+$/, '')),
  accountId: z.coerce.number().int().positive(),
  /** Precisa ser uma caixa do tipo API — as demais têm transporte próprio. */
  inboxId: z.coerce.number().int().positive(),
  apiAccessToken: z.string().min(10).describe('Token de acesso do perfil ou do agent bot.'),
  /**
   * Segredo que o Chatwoot apresenta ao chamar de volta.
   *
   * O webhook de caixa API do Chatwoot não assina o corpo e não permite
   * cabeçalho próprio: o único lugar onde cabe um segredo é a própria URL. Por
   * isso ela é secreta, e por isso a rota confere também `account.id` e
   * `inbox.id` do payload — dois pontos de conferência valem mais que um.
   */
  webhookToken: z.string().min(24),
  /** Nome que aparece no contato quando o WhatsApp não informa o do perfil. */
  fallbackName: z.string().min(1).default('Contato do WhatsApp'),
})

export const typebotConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe('https://typebot.io na versão hospedada, ou o seu domínio.')
    .transform((valor) => valor.replace(/\/+$/, '')),
  /** O `publicId` do fluxo, o mesmo que aparece na URL de compartilhamento. */
  typebotId: z.string().min(1),
  /** Token de API. Só necessário quando o fluxo não é público. */
  apiToken: z.string().min(10).optional(),
  /**
   * Silêncio que encerra a sessão de fluxo.
   *
   * Sem expiração, alguém que voltasse a escrever três semanas depois cairia no
   * meio de um formulário que já não faz sentido.
   */
  sessionTtlMinutes: z.coerce.number().int().min(1).max(10_080).default(360),
  /**
   * O que o cliente digita para escapar do robô. Vazio desliga o escape — só
   * faça isso se houver outro caminho até um humano.
   */
  humanHandoffKeyword: z.string().default('atendente'),
  /** Resposta ao escape, antes de o fluxo se calar para aquele contato. */
  humanHandoffReply: z.string().default('Certo! Vou chamar alguém da equipe.'),
})

export type ChatwootConfig = z.infer<typeof chatwootConfigSchema>
export type TypebotConfig = z.infer<typeof typebotConfigSchema>

const SCHEMAS = {
  chatwoot: chatwootConfigSchema,
  typebot: typebotConfigSchema,
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

export interface LoadedIntegration<K extends IntegrationKind = IntegrationKind> {
  row: IntegrationRow
  config: K extends 'chatwoot' ? ChatwootConfig : TypebotConfig
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

export function parseConfig(kind: IntegrationKind, valor: unknown): ChatwootConfig | TypebotConfig {
  const resultado = SCHEMAS[kind].safeParse(valor)

  if (!resultado.success) {
    throw badRequest(`Configuração inválida para ${kind}.`, {
      issues: resultado.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  return resultado.data
}

export async function saveIntegration(
  db: Database,
  encryptionKey: Buffer,
  input: {
    orgId: string
    sessionId: string
    kind: IntegrationKind
    config: ChatwootConfig | TypebotConfig
    active?: boolean
    /**
     * Id escolhido de fora.
     *
     * O Chatwoot precisa da URL do webhook — que contém este id — no mesmo
     * momento em que a caixa é criada, antes de a linha existir. Escolher o id
     * antes quebra esse ovo-e-galinha sem uma segunda escrita.
     */
    id?: string
  },
): Promise<IntegrationRow> {
  const cifrada = encrypt(JSON.stringify(input.config), encryptionKey)

  const [linha] = await db
    .insert(schema.integrations)
    .values({
      ...(input.id ? { id: input.id } : {}),
      orgId: input.orgId,
      sessionId: input.sessionId,
      kind: input.kind,
      config: cifrada,
      active: input.active ?? true,
    })
    .onConflictDoUpdate({
      target: [schema.integrations.sessionId, schema.integrations.kind],
      set: {
        config: cifrada,
        active: input.active ?? true,
        // Configuração nova zera o erro anterior: ele era do que foi trocado.
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      },
    })
    .returning(COLUMNS)

  if (!linha) throw new Error('falha ao gravar a integração')
  return linha
}

/** Integrações ativas de uma sessão. É a consulta do caminho de mensagem. */
export async function loadActiveIntegrations(
  db: Database,
  sessionId: string,
  encryptionKey: Buffer,
): Promise<LoadedIntegration[]> {
  const linhas = await db
    .select({ ...COLUMNS, config: schema.integrations.config })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.sessionId, sessionId), eq(schema.integrations.active, true)))

  const carregadas: LoadedIntegration[] = []

  for (const { config, ...row } of linhas) {
    try {
      carregadas.push({
        row,
        config: SCHEMAS[row.kind].parse(JSON.parse(decrypt(config, encryptionKey))) as never,
      })
    } catch {
      /**
       * Uma integração ilegível não pode derrubar as outras nem a mensagem.
       *
       * O caso real é rotação de ENCRYPTION_KEY. Quem operar vai ver a conversa
       * parar de chegar na ferramenta; o erro fica registrado na linha para o
       * painel explicar por quê.
       */
      await db
        .update(schema.integrations)
        .set({
          lastError:
            'Configuração ilegível: a ENCRYPTION_KEY atual não é a que gravou estas credenciais. Reconfigure a integração.',
          lastErrorAt: new Date(),
        })
        .where(eq(schema.integrations.id, row.id))
    }
  }

  return carregadas
}

export async function listIntegrations(db: Database, orgId: string): Promise<IntegrationRow[]> {
  return db.select(COLUMNS).from(schema.integrations).where(eq(schema.integrations.orgId, orgId))
}

export async function findIntegrationById(
  db: Database,
  id: string,
  encryptionKey: Buffer,
): Promise<LoadedIntegration | null> {
  const [linha] = await db
    .select({ ...COLUMNS, config: schema.integrations.config })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, id))
    .limit(1)

  if (!linha) return null

  const { config, ...row } = linha
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

/** Registra a última falha para o painel conseguir explicar o silêncio. */
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
