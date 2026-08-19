import type { EngineType, MessageStatus, MessageType, SessionStatus } from '@awah/db'

/**
 * O que cada engine sabe fazer. É a fonte da matriz pública de capacidades: o
 * usuário precisa saber, antes de escolher, que a Cloud API não tem grupos e
 * que o Baileys não tem janela de 24 h.
 */
export interface EngineCapabilities {
  qrPairing: boolean
  codePairing: boolean
  groups: boolean
  channels: boolean
  presence: boolean
  reactions: boolean
  editMessage: boolean
  /** Envio livre, sem template aprovado nem janela de atendimento. */
  freeformMessaging: boolean
}

export interface SendResult {
  engineMessageId: string
  timestamp: Date
}

/**
 * Eventos que uma engine emite para o gerenciador de sessão. O gerenciador é
 * quem traduz isso em escrita no banco — o adapter nunca toca no Postgres
 * diretamente, para que trocar de engine não signifique reescrever persistência.
 */
export type EngineEvent =
  | { type: 'status'; status: SessionStatus; detail?: Record<string, unknown> }
  /** QR novo para exibir. Expira em segundos e é substituído até o pareamento. */
  | { type: 'qr'; qr: string }
  | { type: 'paired'; phoneNumber: string | null }
  /** As credenciais mudaram e precisam ser persistidas. */
  | { type: 'credentials' }
  | {
      type: 'closed'
      rawCode: number | null
      cause: string
      shouldReconnect: boolean
      loggedOut: boolean
    }
  /** Mensagem chegou (ou saiu por outro dispositivo do mesmo número). */
  | {
      type: 'message.received'
      engineMessageId: string
      chatId: string
      fromJid: string | null
      messageType: MessageType
      body: string | null
      fromMe: boolean
      occurredAt: Date
    }
  /** ACK do protocolo: alimenta o funil sent → delivered → read. */
  | {
      type: 'message.status'
      engineMessageId: string
      chatId: string
      status: MessageStatus
      occurredAt: Date
    }

export type EngineEventHandler = (event: EngineEvent) => void

export interface EngineAdapter {
  readonly engine: EngineType
  readonly capabilities: EngineCapabilities

  connect(): Promise<void>

  /**
   * `logout: true` encerra a sessão no aparelho e invalida as credenciais;
   * sem ele, apenas solta a conexão e o auth state segue reutilizável.
   */
  disconnect(options?: { logout?: boolean }): Promise<void>

  /** Pareamento por código de 8 dígitos, alternativa ao QR. */
  requestPairingCode(phoneNumber: string): Promise<string>

  /** QR corrente, se houver um pareamento em andamento. */
  currentQr(): string | null

  /**
   * Se a engine está pronta para enviar de fato.
   *
   * Conectado não é o mesmo que pronto: uma sessão em pareamento tem socket
   * aberto e nenhuma identidade. O scheduler usa isto para devolver o envio à
   * fila em vez de gastar tentativa — indisponibilidade não é falha de entrega,
   * e tratá-la como tal levaria mensagens boas à DLQ enquanto o usuário ainda
   * está escaneando o QR.
   */
  isReady(): boolean

  /**
   * Envio direto na engine. Nenhuma rota chama isto: todo envio entra pelo
   * outbox e é o scheduler quem aciona o adapter, depois do motor de risco
   * liberar a vaga.
   */
  sendText(chatId: string, text: string): Promise<SendResult>

  /**
   * Presença na conversa. O motor de risco usa `composing` antes de enviar, por
   * um tempo proporcional ao texto — mensagem longa que aparece instantânea
   * denuncia automação para quem está com a conversa aberta.
   */
  sendPresence(chatId: string, state: 'composing' | 'paused' | 'available'): Promise<void>
}
