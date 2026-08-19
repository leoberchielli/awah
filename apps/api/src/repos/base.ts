import type { DbExecutor } from '@awah/db'

/**
 * Base de todo repositório com escopo de tenant.
 *
 * A guarda de `org_id` vive aqui, e não nas rotas, por um motivo prático: rota
 * é fácil de esquecer. Toda consulta a dado de tenant passa por uma subclasse
 * disto, que não consegue ser construída sem um `orgId` — o vazamento entre
 * organizações deixa de depender de disciplina em cada handler.
 *
 * Regra de ouro do projeto: se um handler precisa do `db` cru para ler tabela
 * com `org_id`, o repositório está faltando alguma coisa.
 */
export abstract class TenantRepository {
  protected readonly db: DbExecutor
  protected readonly orgId: string

  constructor(db: DbExecutor, orgId: string) {
    if (!orgId) {
      throw new Error('TenantRepository exige um orgId — recusando consulta sem escopo.')
    }
    this.db = db
    this.orgId = orgId
  }

  /** Org à qual este repositório está preso. */
  get organizationId(): string {
    return this.orgId
  }
}
