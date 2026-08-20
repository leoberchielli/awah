import type { DbExecutor } from '@awah/db'

/**
 * Base of every tenant-scoped repository.
 *
 * The `org_id` guard lives here rather than in the routes for a practical
 * reason: a route is easy to forget. Every query against tenant data goes
 * through a subclass of this, which cannot be built without an `orgId` —
 * leaking across organizations stops depending on discipline in each handler.
 *
 * Golden rule of the project: if a handler needs the raw `db` to read a table
 * with `org_id`, the repository is missing something.
 */
export abstract class TenantRepository {
  protected readonly db: DbExecutor
  protected readonly orgId: string

  constructor(db: DbExecutor, orgId: string) {
    if (!orgId) {
      throw new Error('TenantRepository requires an orgId — refusing an unscoped query.')
    }
    this.db = db
    this.orgId = orgId
  }

  /** The org this repository is tied to. */
  get organizationId(): string {
    return this.orgId
  }
}
