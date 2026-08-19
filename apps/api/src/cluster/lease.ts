import type Redis from 'ioredis'

/**
 * Renova apenas se ainda formos o dono.
 *
 * Precisa ser atômico: entre um GET e um PEXPIRE separados cabe a expiração do
 * lease e a tomada por outro nó, e o PEXPIRE então estenderia a posse alheia —
 * dois processos convencidos de que mandam na mesma sessão é exatamente o
 * cenário que produz o 440 "sessão assumida em outro lugar".
 */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`

/** Solta apenas o que é nosso, pelo mesmo motivo. */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

export interface LeaseOptions {
  /** Vida do lease. Passado sem renovação, a sessão fica livre. */
  ttlMs?: number
}

/**
 * Posse exclusiva de sessão entre réplicas.
 *
 * O TTL curto com renovação frequente é deliberado: se o nó dono morre, ninguém
 * renova e a sessão fica disponível em segundos, sem precisar de coordenador,
 * eleição ou intervenção. O preço é que o dono precisa renovar sempre — e
 * perder a renovação significa soltar a sessão na hora, não insistir.
 */
export class SessionLease {
  private readonly ttlMs: number

  constructor(
    private readonly redis: Redis,
    private readonly nodeId: string,
    options: LeaseOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 15_000
  }

  private key(sessionId: string): string {
    return `awah:lease:${sessionId}`
  }

  /** SET NX: só um nó ganha, mesmo com todos tentando ao mesmo tempo. */
  async acquire(sessionId: string): Promise<boolean> {
    const result = await this.redis.set(this.key(sessionId), this.nodeId, 'PX', this.ttlMs, 'NX')
    return result === 'OK'
  }

  /** Devolve false quando a posse foi perdida — quem chama deve soltar a sessão. */
  async renew(sessionId: string): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      this.key(sessionId),
      this.nodeId,
      String(this.ttlMs),
    )
    return result === 1
  }

  async release(sessionId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.key(sessionId), this.nodeId)
  }

  async owner(sessionId: string): Promise<string | null> {
    return this.redis.get(this.key(sessionId))
  }

  async isMine(sessionId: string): Promise<boolean> {
    return (await this.owner(sessionId)) === this.nodeId
  }

  /** Sessões sob posse de alguém, dentre as informadas. */
  async owners(sessionIds: string[]): Promise<Map<string, string>> {
    if (sessionIds.length === 0) return new Map()

    const valores = await this.redis.mget(sessionIds.map((id) => this.key(id)))
    const mapa = new Map<string, string>()

    sessionIds.forEach((id, index) => {
      const dono = valores[index]
      if (dono) mapa.set(id, dono)
    })

    return mapa
  }
}
