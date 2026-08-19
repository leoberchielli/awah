export interface RiskSignals {
  /** Mensagens enviadas nas últimas 24 h. */
  outbound24h: number
  /** Mensagens recebidas nas últimas 24 h. */
  inbound24h: number
  newContacts24h: number
  newContactsLimit: number
  /** Fração de envios que não chegaram ao destinatário, entre 0 e 1. */
  deliveryFailureRate: number
  minuteUsage: number
  minuteLimit: number
}

export interface ScoreFactor {
  name: string
  /** Quanto este sinal somou ao score. */
  points: number
  max: number
  detail: string
}

export interface RiskScore {
  /** 0 a 100. Quanto maior, mais o comportamento se parece com disparo em massa. */
  value: number
  factors: ScoreFactor[]
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Score de risco de bloqueio.
 *
 * Não existe fórmula oficial — o WhatsApp não publica como decide banir. O que
 * este cálculo faz é medir a distância entre o comportamento da sessão e o de
 * um humano conversando, usando os quatro sinais que aparecem de forma
 * consistente nos relatos de bloqueio.
 *
 * O score é explicável de propósito: cada fator devolve quanto somou e por quê,
 * porque um número solto de 0 a 100 não ajuda ninguém a decidir o que mudar.
 */
export function computeScore(signals: RiskSignals): RiskScore {
  const factors: ScoreFactor[] = []

  /**
   * Conversa unilateral, 35 pontos — o sinal mais forte.
   *
   * Gente conversa nos dois sentidos. Uma sessão que envia dez vezes mais do que
   * recebe não está atendendo, está disparando. O +1 no denominador evita
   * divisão por zero e mantém a razão finita quando ninguém respondeu ainda.
   */
  const ratio = signals.outbound24h / (signals.inbound24h + 1)
  const ratioPoints = signals.outbound24h < 10 ? 0 : clamp01((ratio - 2) / 18) * 35
  factors.push({
    name: 'conversa_unilateral',
    points: Math.round(ratioPoints),
    max: 35,
    detail: `${signals.outbound24h} enviadas para ${signals.inbound24h} recebidas em 24 h`,
  })

  /**
   * Contatos novos, 25 pontos. Falar com muitos desconhecidos no mesmo dia é o
   * padrão que mais gera denúncia — e denúncia é o que derruba número.
   */
  const newRatio =
    signals.newContactsLimit > 0 ? signals.newContacts24h / signals.newContactsLimit : 0
  const newContactPoints = clamp01(newRatio) * 25
  factors.push({
    name: 'contatos_novos',
    points: Math.round(newContactPoints),
    max: 25,
    detail: `${signals.newContacts24h} de ${signals.newContactsLimit} permitidos hoje`,
  })

  /**
   * Falha de entrega, 25 pontos. Mensagem que não chega costuma significar
   * número inexistente ou destinatário que bloqueou — os dois indicam lista
   * comprada ou desatualizada, que é o caminho curto para o banimento.
   */
  const failurePoints = clamp01(signals.deliveryFailureRate / 0.3) * 25
  factors.push({
    name: 'falha_de_entrega',
    points: Math.round(failurePoints),
    max: 25,
    detail: `${Math.round(signals.deliveryFailureRate * 100)}% dos envios não chegaram`,
  })

  /**
   * Velocidade, 15 pontos. Pesa menos que os demais porque o orçamento já
   * impede a rajada; aqui o sinal serve para o score reagir antes de o teto ser
   * batido.
   */
  const speedRatio = signals.minuteLimit > 0 ? signals.minuteUsage / signals.minuteLimit : 0
  const speedPoints = clamp01(speedRatio) * 15
  factors.push({
    name: 'velocidade',
    points: Math.round(speedPoints),
    max: 15,
    detail: `${signals.minuteUsage} de ${signals.minuteLimit} no último minuto`,
  })

  const value = Math.min(
    100,
    factors.reduce((total, factor) => total + factor.points, 0),
  )
  return { value, factors }
}

/**
 * Freio proporcional ao score.
 *
 * Abaixo de 40 não interfere: penalizar comportamento normal só faria o
 * integrador desligar o motor. Acima disso a vazão cai progressivamente, e o
 * piso de 10% garante que a sessão nunca para de todo — parar sozinha seria
 * indistinguível de um bug, e o §2 fixou que o motor regula, não bloqueia.
 */
export function throttleFactor(score: number): number {
  if (score < 40) return 1
  if (score >= 90) return 0.1
  if (score >= 70) return 0.25

  // Entre 40 e 70, desce linearmente de 1 até 0,5.
  return 1 - ((score - 40) / 30) * 0.5
}
