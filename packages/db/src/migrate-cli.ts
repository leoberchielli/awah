import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrate'

/** Entry point used by `pnpm db:migrate` during development. */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = join(here, '..', 'migrations')

  try {
    console.log('applying migrations…')
    await runMigrations({ url, migrationsFolder })
    console.log('migrations applied.')
  } catch (error) {
    console.error('migration failed:', error)
    process.exit(1)
  }
}

void main()
