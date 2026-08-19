import type { TypebotConfig } from '../config'

export class TypebotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TypebotError'
  }

  get isPermanente(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }

  /**
   * A sessão de fluxo acabou do lado do Typebot.
   *
   * Acontece quando o fluxo chega ao fim ou quando o servidor dele é
   * reiniciado. Não é falha: é sinal de que a próxima mensagem começa um fluxo
   * novo, e tratar como erro deixaria o contato mudo para sempre.
   */
  get sessaoExpirada(): boolean {
    return this.status === 404
  }
}

interface BlocoRichText {
  type?: string
  text?: string
  children?: BlocoRichText[]
}

interface MensagemTypebot {
  type?: string
  content?: {
    richText?: BlocoRichText[]
    url?: string
    text?: string
  }
}

interface RespostaChat {
  sessionId?: string
  messages?: MensagemTypebot[]
  /** Presente quando o fluxo espera resposta. Ausente significa fluxo encerrado. */
  input?: { type?: string } | null
}

export interface TurnoDeFluxo {
  sessionId: string | null
  textos: string[]
  /** Falso quando o fluxo terminou e não espera mais nada. */
  aguardandoResposta: boolean
}

/**
 * Cliente do Chat API do Typebot.
 *
 * O fluxo vive lá; aqui só entram a mensagem do cliente e a resposta que o
 * fluxo produziu. É o que permite ao operador desenhar no editor do Typebot,
 * que já é bom, e ainda assim receber a entrega durável e o motor de risco do
 * gateway embaixo.
 */
export class TypebotClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(
    private readonly config: TypebotConfig,
    options?: { fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.fetchImpl = options?.fetch ?? fetch
    this.timeoutMs = options?.timeoutMs ?? 20_000
  }

  private async request<T>(caminho: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resposta = await this.fetchImpl(`${this.config.baseUrl}/api/v1${caminho}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiToken
            ? { authorization: `Bearer ${this.config.apiToken}` }
            : undefined),
        },
        body: JSON.stringify(body),
      })

      const texto = await resposta.text()
      const corpo = texto ? safeJson(texto) : null

      if (!resposta.ok) {
        const detalhe = (corpo as { message?: string })?.message ?? texto.slice(0, 200)
        throw new TypebotError(resposta.status, `Typebot respondeu ${resposta.status}: ${detalhe}`)
      }

      return corpo as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** Valida o endereço e o fluxo antes de gravar a integração. */
  async verificar(): Promise<void> {
    await this.iniciar()
  }

  async iniciar(mensagem?: string): Promise<TurnoDeFluxo> {
    const resposta = await this.request<RespostaChat>(
      `/typebots/${encodeURIComponent(this.config.typebotId)}/startChat`,
      { message: mensagem, isStreamEnabled: false },
    )

    return interpretar(resposta)
  }

  async continuar(sessionId: string, mensagem: string): Promise<TurnoDeFluxo> {
    const resposta = await this.request<RespostaChat>(
      `/sessions/${encodeURIComponent(sessionId)}/continueChat`,
      { message: mensagem },
    )

    return { ...interpretar(resposta), sessionId }
  }
}

function interpretar(resposta: RespostaChat): TurnoDeFluxo {
  return {
    sessionId: resposta.sessionId ?? null,
    textos: (resposta.messages ?? []).map(paraTexto).filter((t): t is string => Boolean(t)),
    // Sem `input`, o fluxo chegou ao fim e a próxima mensagem recomeça do zero.
    aguardandoResposta: Boolean(resposta.input),
  }
}

/**
 * Achata o formato do Typebot para o texto que o WhatsApp aceita.
 *
 * O `richText` é uma árvore de parágrafos com filhos; o WhatsApp só entende
 * texto corrido. Mídia vira a URL — honesto e útil enquanto o gateway não envia
 * anexo, e melhor que engolir a mensagem em silêncio.
 */
function paraTexto(mensagem: MensagemTypebot): string | null {
  if (mensagem.content?.richText?.length) {
    const texto = mensagem.content.richText.map(achatar).join('\n').trim()
    return texto || null
  }

  if (mensagem.content?.text) return mensagem.content.text
  if (mensagem.content?.url) return mensagem.content.url

  return null
}

function achatar(bloco: BlocoRichText): string {
  if (bloco.text) return bloco.text
  return (bloco.children ?? []).map(achatar).join('')
}

function safeJson(texto: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    return null
  }
}

/**
 * Deriva endereço e id do fluxo a partir do link que a pessoa tem em mãos.
 *
 * Pedir "baseUrl" e "typebotId" em campos separados obriga quem integra a saber
 * o que é `publicId` e onde ele aparece. O link de compartilhamento já tem os
 * dois, e é o que está na área de transferência de quem acabou de publicar um
 * fluxo.
 */
export function derivarDoLink(link: string): { baseUrl: string; typebotId: string } {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new Error('Isso não parece uma URL. Cole o link de compartilhamento do seu fluxo.')
  }

  const partes = url.pathname.split('/').filter(Boolean)

  /**
   * A URL do editor traz o id interno, que o Chat API não aceita.
   *
   * É o erro mais provável de quem está com o Typebot aberto: copiar da barra de
   * endereços do editor em vez do link de compartilhamento. Sem esta conferência
   * a integração é aceita e só falha depois, na primeira mensagem de um cliente.
   */
  if (partes[0] === 'typebots' || url.hostname.startsWith('app.')) {
    throw new Error(
      'Esse é o link do editor, que usa o id interno do fluxo. Publique o fluxo e use o link de compartilhamento — em Share, no Typebot.',
    )
  }

  const typebotId = partes[0]
  if (!typebotId) {
    throw new Error(
      'Não encontrei o id do fluxo nesse link. Ele deve terminar com o nome do fluxo, como https://typebot.io/meu-fluxo.',
    )
  }

  return { baseUrl: url.origin, typebotId }
}
