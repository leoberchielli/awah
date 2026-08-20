import { join } from 'node:path'
import { runMigrations } from '@awah/db'
import { loadEnv } from './env'

/**
 * Migration entry point bundled into the image, so the container can migrate
 * without depending on tsx or the devDependencies.
 *
 * In compose this runs as the `migrate` service, which the API waits for before
 * it starts.
 */
async function main() {
  const env = loadEnv()
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'packages', 'db', 'migrations')

  try {
    console.log(`applying migrations from ${migrationsFolder}…`)
    await runMigrations({ url: env.DATABASE_URL, migrationsFolder })
    console.log('migrations applied.')
  } catch (error) {
    console.error('migration failed:', error)
    process.exit(1)
  }
}

void main()
