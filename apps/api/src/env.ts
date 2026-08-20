import { hostname } from 'node:os'
import { z } from 'zod'

/** Aceita as grafias usuais de booleano em variável de ambiente. */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  )

/**
 * Marca um campo como opcional tratando string vazia como ausente.
 *
 * `.optional()` sozinho só aceita `undefined`, e orquestrador nenhum fala essa
 * língua: Docker Compose, Kubernetes e o GitHub Actions materializam variável
 * não configurada como string vazia. O `docker-compose.yml` deste repositório
 * declara `PUBLIC_URL: ${PUBLIC_URL:-}` justamente para documentar a variável —
 * e com `.optional()` puro isso derrubava o processo no boot com "Invalid url"
 * para quem tinha acabado de baixar o compose e rodar `docker compose up -d`.
 */
const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const base64Key = (bytes: number) =>
  z.string().refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === bytes
    } catch {
      return false
    }
  }, `must be ${bytes} bytes encoded in base64 (openssl rand -base64 ${bytes})`)

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(2900),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Identidade da réplica no cluster. É o valor gravado em `sessions.owner_node_id`
   * quando esta réplica toma o lease de uma sessão (§4.4).
   */
  NODE_ID: opcional(z.string().min(1)),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1),

  ENCRYPTION_KEY: base64Key(32),
  COOKIE_SECRET: z.string().min(32, 'use at least 32 characters'),

  /**
   * Endereço público da instância, com esquema. Usado para montar a URL que a
   * Meta precisa cadastrar e para apontar o "Try it" da documentação ao lugar
   * certo. Vazio, a API assume `http://localhost:PORT` — correto no laptop,
   * errado atrás de qualquer proxy.
   */
  PUBLIC_URL: opcional(z.string().url()).transform((valor) => valor?.replace(/\/+$/, '')),

  /**
   * Se dá para confiar nos cabeçalhos `X-Forwarded-*`.
   *
   * Confiar sem proxy na frente é um buraco: o rate limit por IP usa
   * `request.ip`, e com esta opção ligada qualquer cliente escolhe o próprio IP
   * pelo cabeçalho e escapa do limite trocando de valor a cada requisição. Aceita
   * `false` (padrão), `true`, um número de saltos, ou uma lista de CIDRs — que é
   * a única forma realmente segura atrás de proxy.
   */
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((valor): boolean | number | string => {
      if (typeof valor === 'boolean') return valor
      const texto = valor.trim()
      if (['1', 'true', 'yes', 'on'].includes(texto.toLowerCase())) return true
      if (['', '0', 'false', 'no', 'off'].includes(texto.toLowerCase())) return false
      const saltos = Number(texto)
      return Number.isInteger(saltos) && saltos > 0 ? saltos : texto
    }),

  /**
   * Teto do corpo da requisição. O padrão do Fastify é 1 MiB e serve: envio de
   * texto não chega perto disso, e um teto alto convida a exaustão de memória.
   */
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(1_048_576),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  ALLOW_OPEN_REGISTRATION: boolish.default(false),

  /**
   * Log da engine de WhatsApp, separado do log da API. O Baileys é
   * extremamente verboso em nível debug — silenciar por padrão evita afogar o
   * log da aplicação, e subir para 'debug' é a primeira coisa a fazer quando
   * uma sessão se recusa a parear.
   */
  ENGINE_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('silent'),

  /** Tentativas de reconexão antes de o gerenciador desistir de uma sessão. */
  MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().positive().max(100).default(10),

  // ---- scheduler de envio ----
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(25),
  /** Envio preso em 'sending' por mais que isto voltou de um processo morto. */
  OUTBOX_STUCK_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  /** Tentativas de entrega antes de a mensagem ir para a DLQ. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().max(50).default(5),

  // ---- webhooks ----
  WEBHOOK_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WEBHOOK_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(20),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),

  /** Envios simultâneos por nó. O jitter humano segura cada um por segundos. */
  OUTBOX_MAX_CONCURRENT: z.coerce.number().int().positive().max(1000).default(50),

  /** Intervalo do expurgo de conteúdo vencido pela política de retenção. */
  RETENTION_SWEEP_MS: z.coerce.number().int().positive().default(600_000),

  // ---- cluster ----
  /** Vida da posse de uma sessão. Expirado, outro nó pode assumir. */
  LEASE_TTL_MS: z.coerce.number().int().min(3000).max(120_000).default(15_000),
  /** Renovação da posse. Precisa ser bem menor que o TTL. */
  LEASE_RENEW_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  /** Intervalo da varredura que assume sessões órfãs. */
  FAILOVER_SCAN_MS: z.coerce.number().int().min(1000).max(300_000).default(10_000),
  FAILOVER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(5),
  /** Espera por resposta de um comando roteado a outro nó. */
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  // ---- telemetria ----
  /**
   * Protege o endpoint /metrics. Sem ele, qualquer um que alcance a porta lê
   * volume de mensagens, número de sessões e saúde da operação.
   */
  METRICS_TOKEN: opcional(z.string().min(16)),
  /** Intervalo da materialização dos agregados horários. */
  AGGREGATOR_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  /** Horas recalculadas a cada passada, para absorver ACK e retry atrasados. */
  AGGREGATOR_LOOKBACK_HOURS: z.coerce.number().int().min(1).max(168).default(6),

  // ---- motor de risco ----
  /**
   * Desliga o motor por completo. Só use com número descartável: sem ele, o
   * gateway dispara na velocidade máxima da fila, que é o comportamento que
   * derruba chip.
   */
  RISK_ENGINE_ENABLED: boolish.default(true),

  // ---- dashboard ----
  /**
   * Onde estão os arquivos do painel. Vazio, a API procura em `public`,
   * `../web/dist` e `apps/web/dist`, nessa ordem, e sobe sem painel se não
   * achar nenhum — a API é útil sozinha.
   */
  DASHBOARD_DIR: opcional(z.string().min(1)),
})

export type Env = z.infer<typeof envSchema> & { NODE_ID: string }

/**
 * Segredos que este repositório distribui para desenvolvimento.
 *
 * Estão no docker-compose e no .env.example, o que significa que qualquer um que
 * leia o projeto pode forjar um cookie de sessão e decifrar o auth state de quem
 * subiu com eles. Em produção o processo se recusa a nascer.
 */
const SEGREDOS_DE_DESENVOLVIMENTO = new Set([
  'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  'awah-dev-cookie-secret-trocar-antes-de-ir-a-producao',
  'YXdhaC1jaS1rZXktbm90LWZvci1wcm9kdWN0aW9uISE=',
  'awah-ci-cookie-secret-nao-usar-em-producao',
])

/**
 * Valida o ambiente uma vez, no boot. Configuração inválida derruba o processo
 * agora em vez de virar erro obscuro no meio de um envio.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }

  const env = {
    ...parsed.data,
    NODE_ID: parsed.data.NODE_ID ?? hostname(),
  }

  if (env.NODE_ENV === 'production') {
    const fracos = (
      [
        ['ENCRYPTION_KEY', env.ENCRYPTION_KEY],
        ['COOKIE_SECRET', env.COOKIE_SECRET],
      ] as const
    )
      .filter(([, valor]) => SEGREDOS_DE_DESENVOLVIMENTO.has(valor))
      .map(([nome]) => nome)

    if (fracos.length > 0) {
      throw new Error(
        [
          `These are the development secrets, published in this repository: ${fracos.join(', ')}.`,
          'Generate your own before exposing the instance:',
          '  ENCRYPTION_KEY: openssl rand -base64 32',
          '  COOKIE_SECRET:  openssl rand -base64 48',
        ].join('\n'),
      )
    }
  }

  return env
}
