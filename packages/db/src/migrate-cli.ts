import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrate'

/** Entrada usada por `pnpm db:migrate` durante o desenvolvimento. */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL não está definida.')
    process.exit(1)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = join(here, '..', 'migrations')

  try {
    console.log('aplicando migrations...')
    await runMigrations({ url, migrationsFolder })
    console.log('migrations aplicadas.')
  } catch (error) {
    console.error('falha ao migrar:', error)
    process.exit(1)
  }
}

void main()
