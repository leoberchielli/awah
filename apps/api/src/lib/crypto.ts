import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Cifra em AES-256-GCM. Usado para o auth state das sessões, que é material de
 * credencial: quem lê a tabela `session_auth` sem a chave não consegue assumir
 * o WhatsApp de ninguém.
 *
 * Formato de saída: `iv.tag.ciphertext`, tudo em base64url.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.')
  if (parts.length !== 3) {
    throw new Error('payload cifrado malformado')
  }

  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, 'base64url')
  const tag = Buffer.from(tagPart, 'base64url')
  const ciphertext = Buffer.from(dataPart, 'base64url')

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('payload cifrado malformado')
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Hash para valores de alta entropia — tokens de sessão e segredos de API key.
 * SHA-256 basta aqui: diferente de senha, o segredo já é aleatório, então não há
 * ataque de dicionário a encarecer.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** Comparação em tempo constante, tolerante a tamanhos diferentes. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
