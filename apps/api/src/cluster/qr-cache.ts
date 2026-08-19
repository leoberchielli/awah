import type Redis from 'ioredis'

/**
 * QR de pareamento compartilhado entre réplicas.
 *
 * O QR nasce na memória do nó que detém a sessão, mas a requisição que vai
 * buscá-lo pode chegar em qualquer outro. Poderia ser resolvido roteando o
 * pedido até o dono; publicar num lugar comum é mais simples e mais rápido, e o
 * dado é efêmero por natureza — o WhatsApp troca o código a cada poucos
 * segundos, então cache velho não é um problema a evitar, é o comportamento
 * esperado.
 *
 * O TTL curto garante que um QR de sessão já pareada não fique disponível
 * depois de perder a validade.
 */
export class QrCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 90,
  ) {}

  private key(sessionId: string): string {
    return `awah:qr:${sessionId}`
  }

  async publish(sessionId: string, qr: string): Promise<void> {
    await this.redis.set(this.key(sessionId), qr, 'EX', this.ttlSeconds)
  }

  async read(sessionId: string): Promise<string | null> {
    return this.redis.get(this.key(sessionId))
  }

  /** Chamado ao parear ou desligar: o código deixou de valer. */
  async clear(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId))
  }
}
