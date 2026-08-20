import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client'

export interface MigrateOptions {
  url: string
  migrationsFolder: string
}

/**
 * Applies the pending migrations.
 *
 * It runs as a step separate from the API boot on purpose: several replicas
 * coming up at the same time must not race each other to migrate the same
 * database. The pool is one connection because migration is serial by nature.
 */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const handle = createDb({ url: options.url, max: 1 })
  try {
    await migrate(handle.db, { migrationsFolder: options.migrationsFolder })
  } finally {
    await handle.close()
  }
}
