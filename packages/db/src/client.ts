import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index'

export interface DbConfig {
  url: string
  /** Tamanho máximo do pool. Cada réplica abre o seu. */
  max?: number
  /** Liga o log de query — só use em desenvolvimento. */
  debug?: boolean
}

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>
  sql: ReturnType<typeof postgres>
  close: () => Promise<void>
}

export function createDb(config: DbConfig): DbHandle {
  const sql = postgres(config.url, {
    max: config.max ?? 10,
    // O driver emite avisos do servidor como notice; sem isto o log fica ruidoso.
    onnotice: () => {},
    // Reconexão fica a cargo do driver; o pool devolve erro enquanto isso.
    connect_timeout: 10,
  })

  const db = drizzle(sql, { schema, logger: config.debug ?? false })

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}

export type Database = DbHandle['db']
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** Aceita tanto o handle quanto uma transação — use nos repositórios. */
export type DbExecutor = Database | Transaction
