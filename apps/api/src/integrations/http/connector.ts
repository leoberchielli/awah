import { sign } from '../../webhooks/signature'
import type { HttpConfig } from '../config'

export class HttpConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpConnectorError'
  }

  /** Configuração errada do outro lado: repetir devolve a mesma recusa. */
  get isPermanente(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }
}

/** O que o gateway posta. Mesma forma do evento `message.received`. */
export interface EventoDeMensagem {
  event: 'message.received'
  data: {
    sessionId: string
    messageId: string
    chatId: string
    from: string | null
    type: string
    body: string | null
    timestamp: string
  }
}

export interface RespostaDoConector {
  status: number
  durationMs: number
  /** Textos que viraram mensagem. Vazio é resposta válida: nem todo evento pede uma. */
  replies: string[]
  /** Corpo cru, truncado. Só para o botão de teste mostrar o que voltou. */
  raw: string
  /**
   * Por que a resposta não virou mensagem, quando não virou. É o diagnóstico
   * que substitui a adivinhação de quem acabou de plugar uma plataforma nova.
   */
  diagnostico: string | null
}

/**
 * O escape para qualquer plataforma.
 *
 * Um webhook comum avisa e esquece: a resposta dele é ignorada. Este conector
 * faz pergunta e resposta — o que voltar no corpo vira mensagem, e entra pela
 * mesma fila de qualquer envio, herdando ordem por conversa, motor de risco e
 * reentrega.
 *
 * É a diferença entre "me avise quando chegar mensagem" e "responda por mim", e
 * é ela que permite a um fluxo do n8n, a uma função serverless ou ao sistema da
 * casa **ser** o robô, sem que ninguém escreva um conector dedicado aqui.
 */
export class HttpConnector {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly config: HttpConfig,
    options?: { fetch?: typeof fetch },
  ) {
    this.fetchImpl = options?.fetch ?? fetch
  }

  async enviar(evento: EventoDeMensagem): Promise<RespostaDoConector> {
    const corpo = JSON.stringify(evento)
    const timestamp = Math.floor(Date.now() / 1000)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const inicio = Date.now()

    try {
      const resposta = await this.fetchImpl(this.config.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'awah-gateway',
          /**
           * Mesma assinatura dos webhooks: HMAC sobre `timestamp.corpo`.
           *
           * Reaproveitar o esquema não é economia de código — é para que quem
           * já valida webhook do AWAH valide isto com a mesma função, e para
           * que o SDK sirva aos dois sem uma segunda implementação.
           */
          ...(this.config.secret
            ? {
                'x-awah-signature': sign(corpo, this.config.secret, timestamp),
                'x-awah-timestamp': String(timestamp),
              }
            : {}),
          ...this.config.headers,
        },
        body: corpo,
      })

      const durationMs = Date.now() - inicio
      const texto = await resposta.text().catch(() => '')

      if (!resposta.ok) {
        throw new HttpConnectorError(
          resposta.status,
          `A plataforma respondeu ${resposta.status}: ${texto.slice(0, 200)}`,
        )
      }

      const { replies, diagnostico } = extrairRespostas(texto, this.config.replyPath)

      return {
        status: resposta.status,
        durationMs,
        replies,
        raw: texto.slice(0, 2000),
        diagnostico,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Encontra os textos de resposta, aceitando as formas que aparecem na prática.
 *
 * Ser permissivo aqui é decisão de adoção: quem monta um fluxo no n8n devolve
 * `{"reply": "..."}` sem pensar, e recusar isso porque a documentação pedia
 * `replies` seria rigor que só produz frustração. O que **não** pode acontecer é
 * o silêncio — daí o diagnóstico junto.
 */
export function extrairRespostas(
  texto: string,
  caminho?: string,
): { replies: string[]; diagnostico: string | null } {
  const limpo = texto.trim()

  // Corpo vazio é resposta legítima: nem todo evento pede uma mensagem de volta.
  if (!limpo) return { replies: [], diagnostico: null }

  let corpo: unknown
  try {
    corpo = JSON.parse(limpo)
  } catch {
    return {
      replies: [],
      diagnostico:
        'A resposta não é JSON. Devolva algo como {"reply":"texto"} — ou corpo vazio, se não houver resposta a enviar.',
    }
  }

  const alvo = caminho ? navegar(corpo, caminho) : corpo

  if (alvo === undefined) {
    return {
      replies: [],
      diagnostico: `Não encontrei "${caminho}" na resposta. Confira o caminho configurado.`,
    }
  }

  const textos = normalizar(alvo)
  if (textos.length > 0) return { replies: textos, diagnostico: null }

  // Objeto sem nenhum campo reconhecido é quase sempre engano de formato.
  if (typeof alvo === 'object' && alvo !== null && !Array.isArray(alvo)) {
    const chaves = Object.keys(alvo as object)
      .slice(0, 6)
      .join(', ')
    return {
      replies: [],
      diagnostico: `A resposta veio com ${chaves || 'nenhum campo'} — nenhum deles é reconhecido como texto. Use "reply", "replies" ou "text".`,
    }
  }

  return { replies: [], diagnostico: null }
}

/** Aceita `reply`, `replies`, `text`, array e string crua. */
function normalizar(valor: unknown): string[] {
  if (typeof valor === 'string') {
    const texto = valor.trim()
    return texto ? [texto] : []
  }

  if (Array.isArray(valor)) return valor.flatMap(normalizar)

  if (typeof valor === 'object' && valor !== null) {
    const objeto = valor as Record<string, unknown>
    for (const chave of ['replies', 'reply', 'messages', 'message', 'text']) {
      if (chave in objeto) return normalizar(objeto[chave])
    }
  }

  return []
}

/** Caminho por ponto, para quem devolve a resposta aninhada. */
function navegar(corpo: unknown, caminho: string): unknown {
  return caminho
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((atual, parte) => {
      if (typeof atual !== 'object' || atual === null) return undefined
      return (atual as Record<string, unknown>)[parte]
    }, corpo)
}

/**
 * Evento de exemplo do botão de teste.
 *
 * Tem a mesma forma do real de propósito: quem constrói o fluxo do outro lado
 * consegue montar tudo em cima desta amostra e depois só ligar. O número é o
 * reservado para documentação, para ninguém sair respondendo a um desconhecido.
 */
export const EVENTO_DE_TESTE: EventoDeMensagem = {
  event: 'message.received',
  data: {
    sessionId: '00000000-0000-0000-0000-000000000000',
    messageId: 'wamid.TESTE',
    chatId: '5511999999999@s.whatsapp.net',
    from: '5511999999999@s.whatsapp.net',
    type: 'text',
    body: 'Mensagem de teste do AWAH',
    timestamp: '2026-01-01T12:00:00.000Z',
  },
}
