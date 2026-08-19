import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client'

export interface MigrateOptions {
  url: string
  migrationsFolder: string
}

/**
 * Aplica as migrations pendentes.
 *
 * Roda como passo separado do boot da API de propósito: várias réplicas subindo
 * ao mesmo tempo não devem competir para migrar o mesmo banco. O pool é de uma
 * conexão porque migration é serial por natureza.
 */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const handle = createDb({ url: options.url, max: 1 })
  try {
    await migrate(handle.db, { migrationsFolder: options.migrationsFolder })
  } finally {
    await handle.close()
  }
}
