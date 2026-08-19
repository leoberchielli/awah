import { and, type Database, eq, schema } from '@awah/db'
import type Redis from 'ioredis'
import type { SessionLimits } from './limits'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Sobrevive à janela de 24 h com folga, sem vazar memória de sessão morta. */
const KEY_TTL_SECONDS = 26 * 60 * 60

export interface BudgetUsage {
  minute: number
  hour: number
  day: number
  newContactsToday: number
}

export interface BudgetVerdict {
  /** Janela que está cheia, ou null quando há vaga. */
  exceeded: keyof BudgetUsage | null
  usage: BudgetUsage
  /** Quando a janela cheia abre. Null quando não há bloqueio. */
  availableAt: Date | null
}

/**
 * Contadores de envio em janela deslizante.
 *
 * Janela deslizante e não balde por hora cheia: um balde permitiria mandar o
 * teto inteiro às 13h59 e o teto de novo às 14h00, que é justamente a rajada
 * que se quer evitar. O ZSET guarda o instante de cada envio e a contagem
 * pergunta "quantos nos últimos N segundos".
 *
 * Vive no Redis porque é consultado no caminho quente de cada envio, e porque a
 * partir da onda 4 várias réplicas compartilham o mesmo orçamento por sessão.
 */
export class BudgetTracker {
  constructor(
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private sentKey(sessionId: string): string {
    return `awah:risk:${sessionId}:sent`
  }

  private newContactsKey(sessionId: string): string {
    return `awah:risk:${sessionId}:new-contacts`
  }

  private contactsKey(sessionId: string): string {
    return `awah:risk:${sessionId}:contacts`
  }

  async usage(sessionId: string): Promise<BudgetUsage> {
    const agora = this.now()
    const sent = this.sentKey(sessionId)

    const [minute, hour, day, newContactsToday] = await Promise.all([
      this.redis.zcount(sent, agora - MINUTE, '+inf'),
      this.redis.zcount(sent, agora - HOUR, '+inf'),
      this.redis.zcount(sent, agora - DAY, '+inf'),
      this.redis.zcount(this.newContactsKey(sessionId), agora - DAY, '+inf'),
    ])

    return { minute, hour, day, newContactsToday }
  }

  /**
   * Confere as janelas contra os limites já ajustados pelo warmup.
   *
   * A ordem importa: reporta a janela mais restritiva primeiro, para que a ETA
   * devolvida ao usuário seja a que realmente vale.
   */
  async check(
    sessionId: string,
    limits: SessionLimits,
    isNewContact: boolean,
  ): Promise<BudgetVerdict> {
    const usage = await this.usage(sessionId)

    if (isNewContact && usage.newContactsToday >= limits.newContactsPerDay) {
      return {
        exceeded: 'newContactsToday',
        usage,
        availableAt: await this.windowOpensAt(this.newContactsKey(sessionId), DAY),
      }
    }

    if (usage.minute >= limits.perMinute) {
      return {
        exceeded: 'minute',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), MINUTE),
      }
    }

    if (usage.hour >= limits.perHour) {
      return {
        exceeded: 'hour',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), HOUR),
      }
    }

    if (usage.day >= limits.perDay) {
      return {
        exceeded: 'day',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), DAY),
      }
    }

    return { exceeded: null, usage, availableAt: null }
  }

  /**
   * Quando a janela volta a ter vaga: é o instante em que o registro mais antigo
   * dentro dela sai. Devolver isto — e não um atraso fixo — é o que permite
   * mostrar uma ETA honesta no dashboard em vez de "tente de novo depois".
   */
  private async windowOpensAt(key: string, windowMs: number): Promise<Date> {
    const agora = this.now()

    // O registro mais antigo ainda dentro da janela; ao sair, abre uma vaga.
    const maisAntigo = await this.redis.zrangebyscore(
      key,
      agora - windowMs,
      '+inf',
      'WITHSCORES',
      'LIMIT',
      0,
      1,
    )

    const score = maisAntigo[1]
    if (!score) return new Date(agora + 1000)

    const expira = Number(score) + windowMs
    // Piso curto evita reavaliação em laço apertado quando a vaga é iminente.
    return new Date(Math.max(expira, agora + 250))
  }

  /** Registra o envio nas janelas. Chamado depois da entrega bem-sucedida. */
  async record(sessionId: string, chatId: string, isNewContact: boolean): Promise<void> {
    const agora = this.now()
    const sent = this.sentKey(sessionId)
    const pipeline = this.redis.pipeline()

    pipeline.zadd(sent, agora, `${agora}:${chatId}`)
    // Poda o que já saiu da maior janela, para o ZSET não crescer sem limite.
    pipeline.zremrangebyscore(sent, '-inf', agora - DAY)
    pipeline.expire(sent, KEY_TTL_SECONDS)

    if (isNewContact) {
      const novos = this.newContactsKey(sessionId)
      pipeline.zadd(novos, agora, chatId)
      pipeline.zremrangebyscore(novos, '-inf', agora - DAY)
      pipeline.expire(novos, KEY_TTL_SECONDS)
    }

    pipeline.sadd(this.contactsKey(sessionId), chatId)
    pipeline.expire(this.contactsKey(sessionId), KEY_TTL_SECONDS)

    await pipeline.exec()
  }

  /**
   * Se esta sessão já trocou mensagem com o destinatário.
   *
   * O Redis é cache, não fonte de verdade: um miss consulta o Postgres e
   * repovoa. Sem esse fallback, um restart do Redis faria a base inteira de
   * contatos parecer nova e o teto diário de contatos novos travaria a operação
   * de quem só está respondendo conversas antigas.
   */
  async isKnownContact(sessionId: string, chatId: string): Promise<boolean> {
    const cached = await this.redis.sismember(this.contactsKey(sessionId), chatId)
    if (cached === 1) return true

    const [existing] = await this.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.sessionId, sessionId), eq(schema.messages.chatId, chatId)))
      .limit(1)

    if (!existing) return false

    await this.redis.sadd(this.contactsKey(sessionId), chatId)
    await this.redis.expire(this.contactsKey(sessionId), KEY_TTL_SECONDS)
    return true
  }

  /** Zera os contadores de uma sessão. Usado no logout e em teste. */
  async reset(sessionId: string): Promise<void> {
    await this.redis.del(
      this.sentKey(sessionId),
      this.newContactsKey(sessionId),
      this.contactsKey(sessionId),
    )
  }
}
