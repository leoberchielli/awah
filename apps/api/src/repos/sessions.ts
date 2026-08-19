import {
  and,
  type DesiredState,
  desc,
  type EngineType,
  eq,
  inArray,
  type SessionEventType,
  type SessionStatus,
  schema,
} from '@awah/db'
import { TenantRepository } from './base'

export interface SessionRow {
  id: string
  name: string
  engine: EngineType
  status: SessionStatus
  desiredState: DesiredState
  phoneNumber: string | null
  ownerNodeId: string | null
  pairedAt: Date | null
  lastConnectedAt: Date | null
  lastDisconnectedAt: Date | null
  createdAt: Date
}

export interface SessionEventRow {
  id: string
  type: SessionEventType
  rawCode: number | null
  cause: string | null
  nodeId: string | null
  createdAt: Date
}

const SESSION_COLUMNS = {
  id: schema.sessions.id,
  name: schema.sessions.name,
  engine: schema.sessions.engine,
  status: schema.sessions.status,
  desiredState: schema.sessions.desiredState,
  phoneNumber: schema.sessions.phoneNumber,
  ownerNodeId: schema.sessions.ownerNodeId,
  pairedAt: schema.sessions.pairedAt,
  lastConnectedAt: schema.sessions.lastConnectedAt,
  lastDisconnectedAt: schema.sessions.lastDisconnectedAt,
  createdAt: schema.sessions.createdAt,
}

export class SessionRepository extends TenantRepository {
  /**
   * `scope` vem do `sessionScope` da chave de API: nulo alcança todas as sessões
   * da org, uma lista restringe às informadas.
   */
  async list(scope?: string[] | null): Promise<SessionRow[]> {
    const filters = [eq(schema.sessions.orgId, this.orgId)]
    if (scope) {
      // Escopo vazio não alcança nada — devolver tudo aqui seria o pior default.
      if (scope.length === 0) return []
      filters.push(inArray(schema.sessions.id, scope))
    }

    return this.db
      .select(SESSION_COLUMNS)
      .from(schema.sessions)
      .where(and(...filters))
      .orderBy(desc(schema.sessions.createdAt))
  }

  async findById(id: string): Promise<SessionRow | null> {
    const [row] = await this.db
      .select(SESSION_COLUMNS)
      .from(schema.sessions)
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.orgId, this.orgId)))
      .limit(1)

    return row ?? null
  }

  async create(input: { name: string; engine: EngineType }): Promise<SessionRow> {
    const [row] = await this.db
      .insert(schema.sessions)
      .values({ orgId: this.orgId, name: input.name, engine: input.engine })
      .returning(SESSION_COLUMNS)

    if (!row) throw new Error('falha ao criar sessão')
    return row
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.orgId, this.orgId)))
      .returning({ id: schema.sessions.id })

    return rows.length > 0
  }

  async setStatus(
    id: string,
    status: SessionStatus,
    extra?: {
      phoneNumber?: string | null
      ownerNodeId?: string | null
      pairedAt?: Date
      lastConnectedAt?: Date
      lastDisconnectedAt?: Date
    },
  ): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ status, ...extra, updatedAt: new Date() })
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.orgId, this.orgId)))
  }

  /** Grava a intenção do operador. O failover só assume o que está 'running'. */
  async setDesiredState(id: string, desired: DesiredState): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ desiredState: desired, updatedAt: new Date() })
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.orgId, this.orgId)))
  }

  /**
   * Mescla um patch em `sessions.config`, preservando as demais chaves.
   *
   * Sobrescrever o objeto inteiro apagaria configuração de outras áreas — proxy,
   * opções da engine — a cada ajuste de limite de risco.
   */
  async updateConfig(id: string, patch: Record<string, unknown>): Promise<void> {
    const [session] = await this.db
      .select({ config: schema.sessions.config })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.orgId, this.orgId)))
      .limit(1)

    const atual =
      typeof session?.config === 'object' && session.config !== null
        ? (session.config as Record<string, unknown>)
        : {}

    await this.db
      .update(schema.sessions)
      .set({ config: { ...atual, ...patch }, updatedAt: new Date() })
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.orgId, this.orgId)))
  }

  /**
   * Registra um ponto da trilha de conexão. Toda queda vira uma linha aqui, com
   * o código bruto do protocolo ao lado da causa traduzida — é o que alimenta a
   * timeline de desconexão do dashboard.
   */
  async recordEvent(input: {
    sessionId: string
    type: SessionEventType
    rawCode?: number | null
    cause?: string | null
    nodeId?: string | null
    detail?: Record<string, unknown>
  }): Promise<void> {
    await this.db.insert(schema.sessionEvents).values({
      orgId: this.orgId,
      sessionId: input.sessionId,
      type: input.type,
      rawCode: input.rawCode ?? null,
      cause: input.cause ?? null,
      nodeId: input.nodeId ?? null,
      detail: input.detail ?? null,
    })
  }

  async listEvents(sessionId: string, limit = 100): Promise<SessionEventRow[]> {
    return this.db
      .select({
        id: schema.sessionEvents.id,
        type: schema.sessionEvents.type,
        rawCode: schema.sessionEvents.rawCode,
        cause: schema.sessionEvents.cause,
        nodeId: schema.sessionEvents.nodeId,
        createdAt: schema.sessionEvents.createdAt,
      })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.orgId, this.orgId),
          eq(schema.sessionEvents.sessionId, sessionId),
        ),
      )
      .orderBy(desc(schema.sessionEvents.createdAt))
      .limit(limit)
  }
}
