/**
 * Amostra de uma distribuição log-normal, por Box-Muller.
 *
 * Log-normal e não uniforme porque é assim que intervalo humano se comporta: a
 * maioria das pausas fica perto da mediana, e de vez em quando aparece uma bem
 * mais longa — a pessoa foi buscar café. Intervalo uniforme produz um padrão
 * regular, que é justamente o que se quer evitar.
 */
export function logNormal(medianMs: number, sigma: number, random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON)
  const u2 = random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(Math.log(medianMs) + sigma * z)
}

export interface HumanDelayOptions {
  /** Mediana do intervalo entre envios, em ms. */
  medianMs?: number
  /** Dispersão da cauda. Acima de 1 produz pausas muito longas. */
  sigma?: number
  /** Score de risco: quanto maior, mais lento o ritmo. */
  throttleFactor?: number
  maxMs?: number
  random?: () => number
}

/**
 * Intervalo antes do próximo envio.
 *
 * O `throttleFactor` divide o ritmo: fator 0,25 significa quatro vezes mais
 * espera entre mensagens. É assim que o freio do score chega ao comportamento
 * observável sem precisar recusar nada.
 */
export function humanDelayMs(options: HumanDelayOptions = {}): number {
  const {
    medianMs = 3000,
    sigma = 0.55,
    throttleFactor = 1,
    maxMs = 120_000,
    random = Math.random,
  } = options

  const fator = throttleFactor > 0 ? throttleFactor : 0.1
  const amostra = logNormal(medianMs / fator, sigma, random)

  return Math.round(Math.min(Math.max(amostra, 250), maxMs))
}

/**
 * Quanto tempo exibir "digitando" antes de enviar.
 *
 * Proporcional ao texto, em ritmo de digitação humana. Uma mensagem de trezentos
 * caracteres que aparece instantaneamente denuncia automação para qualquer um
 * que esteja com a conversa aberta.
 */
export function typingDurationMs(
  textLength: number,
  options: { charsPerSecond?: number; minMs?: number; maxMs?: number } = {},
): number {
  const { charsPerSecond = 18, minMs = 700, maxMs = 9000 } = options

  const estimado = (textLength / charsPerSecond) * 1000
  return Math.round(Math.min(Math.max(estimado, minMs), maxMs))
}
