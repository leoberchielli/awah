import { exponentialBackoff } from '../lib/backoff'

/**
 * Tradução dos códigos de desconexão do protocolo para causa legível.
 *
 * Esta tabela é pequena e é boa parte do valor do produto. Quem opera Baileys
 * hoje vê `Connection Closed` no log e não sabe se perdeu a internet, se abriu o
 * WhatsApp Web em outra aba ou se o número foi banido — três incidentes com
 * respostas completamente diferentes. A timeline de quedas do dashboard lê daqui.
 */
export interface DisconnectInfo {
  /** Frase curta mostrada na timeline. */
  cause: string
  /** O que fazer a respeito. */
  guidance: string
  /** Se vale reconectar sozinho. */
  shouldReconnect: boolean
  /** Se as credenciais morreram e a sessão precisa parear de novo. */
  loggedOut: boolean
}

const UNKNOWN: DisconnectInfo = {
  cause: 'Motivo desconhecido',
  guidance: 'Verifique os logs da sessão. A reconexão automática segue tentando.',
  shouldReconnect: true,
  loggedOut: false,
}

const TABLE: Record<number, DisconnectInfo> = {
  401: {
    cause: 'Sessão encerrada no aparelho',
    guidance:
      'O aparelho desconectou este dispositivo. É preciso parear de novo — a reconexão automática não resolve.',
    shouldReconnect: false,
    loggedOut: true,
  },
  403: {
    cause: 'Acesso negado pelo WhatsApp',
    guidance:
      'Normalmente indica número bloqueado ou restrito. Não insista na reconexão: repetir agrava a restrição.',
    shouldReconnect: false,
    loggedOut: true,
  },
  408: {
    cause: 'Tempo esgotado',
    guidance: 'A conexão não respondeu a tempo. Costuma ser rede instável e resolve sozinho.',
    shouldReconnect: true,
    loggedOut: false,
  },
  411: {
    cause: 'Incompatibilidade de multi-dispositivo',
    guidance: 'O aparelho precisa estar com multi-dispositivo ativo. Pareie novamente.',
    shouldReconnect: false,
    loggedOut: true,
  },
  428: {
    cause: 'Conexão fechada',
    guidance:
      'Queda comum de socket. A reconexão automática costuma resolver na primeira tentativa.',
    shouldReconnect: true,
    loggedOut: false,
  },
  440: {
    cause: 'Sessão assumida em outro lugar',
    guidance:
      'A mesma credencial foi aberta em outro processo — WhatsApp Web, outra instância ou duas réplicas disputando a sessão. Reconectar em laço vira briga entre as duas pontas: confirme quem é o dono antes.',
    shouldReconnect: false,
    loggedOut: false,
  },
  500: {
    cause: 'Sessão corrompida',
    guidance: 'O auth state ficou inconsistente. Limpe as credenciais e pareie de novo.',
    shouldReconnect: false,
    loggedOut: true,
  },
  503: {
    cause: 'Serviço indisponível',
    guidance: 'Instabilidade do lado do WhatsApp. Reconectar com espera maior.',
    shouldReconnect: true,
    loggedOut: false,
  },
  515: {
    cause: 'Reinício exigido',
    guidance:
      'O protocolo pede que o socket seja recriado logo após o pareamento. É esperado e a reconexão é imediata.',
    shouldReconnect: true,
    loggedOut: false,
  },
}

export function describeDisconnect(rawCode: number | null | undefined): DisconnectInfo {
  if (rawCode == null) return UNKNOWN
  return TABLE[rawCode] ?? UNKNOWN
}

/**
 * Extrai o código de status de um erro do Baileys sem depender do tipo do Boom.
 * O formato é `error.output.statusCode`.
 */
export function statusCodeFromError(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null

  const output = (error as { output?: unknown }).output
  if (typeof output === 'object' && output !== null) {
    const code = (output as { statusCode?: unknown }).statusCode
    if (typeof code === 'number') return code
  }

  const direct = (error as { statusCode?: unknown }).statusCode
  return typeof direct === 'number' ? direct : null
}

/** Espera antes da próxima tentativa de conexão: de 1 s até o teto de 5 min. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return exponentialBackoff({ attempt, baseMs: 1000, capMs: 300_000, random })
}
