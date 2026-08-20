import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index'

export interface DbConfig {
  url: string
  /** Maximum pool size. Each replica opens its own. */
  max?: number
  /** Turns on query logging — development only. */
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
    // The driver emits server warnings as notices; without this the log gets noisy.
    onnotice: () => {},
    // Reconnection is the driver's job; the pool returns errors meanwhile.
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

/** Takes either the handle or a transaction — use this in the repositories. */
export type DbExecutor = Database | Transaction
