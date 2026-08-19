import { hash, verify } from '@node-rs/argon2'

/**
 * Parâmetros do argon2id na recomendação do OWASP: 19 MiB de memória, 2
 * iterações, paralelismo 1. Custo alto o bastante para tornar força bruta cara,
 * baixo o bastante para um login não segurar o event loop.
 *
 * O algoritmo não é passado explicitamente porque argon2id já é o padrão da
 * biblioteca, e `Algorithm` é um const enum ambiente — importá-lo quebra sob
 * `verbatimModuleSyntax`.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

/**
 * Devolve false em vez de propagar erro quando o digest está corrompido — quem
 * chama trata "senha errada" e "hash quebrado" da mesma forma, e a diferença
 * entre os dois não deve vazar para o cliente.
 */
export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS)
  } catch {
    return false
  }
}
