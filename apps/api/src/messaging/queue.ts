import type { MessageType } from '@awah/db'
import { type Database, sql } from '@awah/db'

/**
 * Operações de fila do outbox.
 *
 * Ao contrário do resto do acesso a dados, estas funções atravessam
 * organizações de propósito: o scheduler é infraestrutura do nó e trabalha
 * sobre as sessões que este processo hospeda, sejam de quem forem. Toda leitura
 * originada de uma requisição HTTP continua passando pelo repositório com
 * escopo de tenant.
 */

export interface ClaimedJob {
  id: string
  orgId: string
  sessionId: string
  chatId: string
  clientMessageId: string
  type: MessageType
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

/**
 * Reserva até `limit` envios elegíveis.
 *
 * Duas garantias moram nesta consulta:
 *
 * 1. **FIFO por chat** — `DISTINCT ON (session_id, chat_id) … ORDER BY seq` pega
 *    somente a cabeça de cada fila de conversa, e o `NOT EXISTS` impede reservar
 *    a próxima enquanto a anterior ainda está saindo. Chats diferentes seguem
 *    em paralelo.
 * 2. **Exclusividade entre workers** — o `UPDATE … WHERE status = 'queued'` só
 *    afeta linhas que ainda estavam na fila. Se outra réplica reservou no
 *    intervalo, o status já mudou e a linha simplesmente não volta no RETURNING.
 *    É o mesmo efeito de um SKIP LOCKED, sem o risco de combinar bloqueio
 *    explícito com subconsulta agregada.
 */
export async function claimOutbox(
  db: Database,
  sessionIds: string[],
  limit: number,
): Promise<ClaimedJob[]> {
  if (sessionIds.length === 0 || limit <= 0) return []

  /**
   * Um parâmetro por id, em vez de um array interpolado. Interpolar o array
   * inteiro faz o driver enviá-lo como texto, e o Postgres rejeita com
   * "malformed array literal" — o `IN` com parâmetros individuais é explícito e
   * continua imune a injeção.
   */
  const ids = sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

  const result = await db.execute(sql`
    WITH heads AS (
      SELECT DISTINCT ON (o.session_id, o.chat_id) o.id
      FROM outbox_messages o
      WHERE o.status = 'queued'
        AND o.available_at <= now()
        AND o.session_id IN (${ids})
        AND NOT EXISTS (
          SELECT 1 FROM outbox_messages busy
          WHERE busy.session_id = o.session_id
            AND busy.chat_id = o.chat_id
            AND busy.status = 'sending'
        )
      ORDER BY o.session_id, o.chat_id, o.seq
      LIMIT ${limit}
    )
    UPDATE outbox_messages target
    SET status = 'sending', updated_at = now()
    FROM heads
    WHERE target.id = heads.id
      AND target.status = 'queued'
    RETURNING
      target.id,
      target.org_id,
      target.session_id,
      target.chat_id,
      target.client_message_id,
      target.type,
      target.payload,
      target.attempts,
      target.max_attempts
  `)

  return [...result].map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      orgId: String(r.org_id),
      sessionId: String(r.session_id),
      chatId: String(r.chat_id),
      clientMessageId: String(r.client_message_id),
      type: r.type as MessageType,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
    }
  })
}

export async function markSent(db: Database, id: string, engineMessageId: string): Promise<void> {
  await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'sent',
        engine_message_id = ${engineMessageId},
        sent_at = now(),
        updated_at = now(),
        last_error = NULL
    WHERE id = ${id}::uuid
  `)
}

/**
 * Devolve o envio à fila com espera, ou o manda para a DLQ ao esgotar as
 * tentativas. Nunca descarta: mensagem morta continua consultável e pode ser
 * reprocessada.
 */
export async function markFailed(
  db: Database,
  id: string,
  error: string,
  nextDelayMs: number,
): Promise<'queued' | 'dead'> {
  const result = await db.execute(sql`
    UPDATE outbox_messages
    SET attempts = attempts + 1,
        last_error = ${error.slice(0, 2000)},
        updated_at = now(),
        status = CASE
          WHEN attempts + 1 >= max_attempts THEN 'dead'::outbox_status
          ELSE 'queued'::outbox_status
        END,
        available_at = CASE
          WHEN attempts + 1 >= max_attempts THEN available_at
          ELSE now() + (${nextDelayMs} || ' milliseconds')::interval
        END
    WHERE id = ${id}::uuid
    RETURNING status
  `)

  const first = [...result][0] as { status?: string } | undefined
  return first?.status === 'dead' ? 'dead' : 'queued'
}

/**
 * Segura o envio até a janela de orçamento abrir.
 *
 * Estado próprio, separado de `queued`, porque a diferença importa para quem
 * opera: `held` significa "o motor de risco está protegendo seu número", com
 * hora marcada para sair. Não consome tentativa — não houve falha alguma.
 */
export async function hold(db: Database, id: string, until: Date, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'queued',
        held_reason = ${reason},
        available_at = ${until.toISOString()}::timestamptz,
        updated_at = now()
    WHERE id = ${id}::uuid AND status = 'sending'
  `)
}

/**
 * Devolve à fila sem consumir tentativa. Usado quando a sessão saiu do ar entre
 * a reserva e o envio — não houve falha de entrega, apenas não há por onde sair
 * agora.
 */
export async function release(db: Database, id: string, delayMs = 5000): Promise<void> {
  await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'queued',
        available_at = now() + (${delayMs} || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = ${id}::uuid AND status = 'sending'
  `)
}

/**
 * Solta envios que ficaram presos em 'sending' — o processo morreu entre a
 * reserva e a conclusão. Sem isto, a fila daquele chat trava para sempre, já que
 * o `NOT EXISTS` do claim continuaria enxergando um envio em curso que não
 * existe mais.
 */
export async function recoverStuck(db: Database, olderThanMs: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'queued', updated_at = now()
    WHERE status = 'sending'
      AND updated_at < now() - (${olderThanMs} || ' milliseconds')::interval
    RETURNING id
  `)

  return [...result].length
}
