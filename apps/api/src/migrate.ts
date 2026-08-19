import { join } from 'node:path'
import { runMigrations } from '@awah/db'
import { loadEnv } from './env'

/**
 * Entrada de migration empacotada na imagem, para que o container consiga
 * migrar sem depender de tsx ou das devDependencies.
 *
 * No compose isto roda como serviço `migrate`, que a API espera concluir antes
 * de subir.
 */
async function main() {
  const env = loadEnv()
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'packages', 'db', 'migrations')

  try {
    console.log(`aplicando migrations de ${migrationsFolder}...`)
    await runMigrations({ url: env.DATABASE_URL, migrationsFolder })
    console.log('migrations aplicadas.')
  } catch (error) {
    console.error('falha ao migrar:', error)
    process.exit(1)
  }
}

void main()
