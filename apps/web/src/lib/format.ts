/** Formatações compartilhadas. Uma vez só, para os números baterem entre telas. */

const inteiro = new Intl.NumberFormat('pt-BR')
const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

export const num = (valor: number): string => inteiro.format(Math.round(valor))

export function pct(fracao: number): string {
  return `${decimal.format(fracao * 100)}%`
}

/** Duração legível: quem lê "3,2 s" entende mais rápido que "3200 ms". */
export function duracao(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${decimal.format(ms / 1000)} s`
  if (ms < 3_600_000) return `${decimal.format(ms / 60_000)} min`
  return `${decimal.format(ms / 3_600_000)} h`
}

export function minutos(valor: number | null): string {
  if (valor === null) return '—'
  if (valor < 60) return `${Math.round(valor)} min`
  if (valor < 1440) return `${decimal.format(valor / 60)} h`
  return `${decimal.format(valor / 1440)} d`
}

export function desde(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'agora há pouco'
  return `há ${duracao(ms)}`
}

export function horario(iso: string | Date): string {
  const data = typeof iso === 'string' ? new Date(iso) : iso
  return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function dataHora(iso: string | Date): string {
  const data = typeof iso === 'string' ? new Date(iso) : iso
  return data.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Telefone brasileiro fica ilegível sem separação; o resto passa cru. */
export function telefone(valor: string | null): string {
  if (!valor) return '—'
  const digitos = valor.replace(/\D/g, '')
  if (digitos.length === 13 && digitos.startsWith('55')) {
    return `+55 (${digitos.slice(2, 4)}) ${digitos.slice(4, 9)}-${digitos.slice(9)}`
  }
  if (digitos.length === 12 && digitos.startsWith('55')) {
    return `+55 (${digitos.slice(2, 4)}) ${digitos.slice(4, 8)}-${digitos.slice(8)}`
  }
  return `+${digitos}`
}

/** Um JID inteiro come a coluna toda e não diz nada a mais que o número. */
export function chat(chatId: string): string {
  const semSufixo = chatId.replace(/@.*$/, '')
  if (chatId.includes('@g.us')) return `Grupo ${semSufixo.slice(-6)}`
  return telefone(semSufixo)
}

/**
 * Estado da sessão em português.
 *
 * Vive aqui, e não na tela de Sessões, porque mais de uma tela mostra estado —
 * e um estado novo na engine tem que aparecer traduzido em todas de uma vez,
 * não só naquela onde alguém lembrou de atualizar o mapa.
 */
const ROTULO_POR_STATUS: Record<string, string> = {
  connected: 'Conectada',
  connecting: 'Conectando',
  pairing: 'Pareando',
  created: 'Criada',
  disconnected: 'Desconectada',
  logged_out: 'Deslogada',
  banned: 'Banida',
}

export function statusDeSessao(status: string): string {
  return ROTULO_POR_STATUS[status] ?? status
}
