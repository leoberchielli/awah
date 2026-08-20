import { describe, expect, it, vi } from 'vitest'
import { ChatwootClient, ChatwootError } from '../src/integrations/chatwoot/client'
import { chatwootConfigSchema, typebotConfigSchema } from '../src/integrations/config'
import { deriveFromLink, TypebotClient, TypebotError } from '../src/integrations/typebot/client'

function response(body: unknown, status = 200): Response {
  const withoutBody = status === 204 || status === 304
  return new Response(withoutBody ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CHATWOOT = chatwootConfigSchema.parse({
  baseUrl: 'https://chat.exemplo.com/',
  accountId: 1,
  inboxId: 7,
  apiAccessToken: 'token-de-acesso-do-agente',
  webhookToken: 'w'.repeat(32),
})

const TYPEBOT = typebotConfigSchema.parse({
  baseUrl: 'https://typebot.exemplo.com',
  typebotId: 'meu-fluxo',
})

describe('configuração', () => {
  it('descarta a barra final para não gerar URL com barra dupla', () => {
    expect(CHATWOOT.baseUrl).toBe('https://chat.exemplo.com')
  })

  it('exige token de webhook longo o bastante para não ser adivinhado', () => {
    expect(() => chatwootConfigSchema.parse({ ...CHATWOOT, webhookToken: 'curto' })).toThrow()
  })

  /** The escape to a human ships on; turning it off has to be a choice. */
  it('traz a palavra de escape por padrão', () => {
    expect(TYPEBOT.humanHandoffKeyword).toBe('agent')
    expect(TYPEBOT.sessionTtlMinutes).toBeGreaterThan(0)
  })
})

describe('cliente do Chatwoot', () => {
  it('autentica pelo cabeçalho que o Chatwoot espera', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return response({ name: 'WhatsApp', channel_type: 'Channel::Api' })
    })

    await new ChatwootClient(CHATWOOT, { fetch: fetchImpl as unknown as typeof fetch }).verify()

    expect(calls[0]?.url).toBe('https://chat.exemplo.com/api/v1/accounts/1/inboxes/7')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.api_access_token).toBe('token-de-acesso-do-agente')
  })

  it('reporta o tipo da caixa, para a rota recusar o que não é API', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ name: 'Site', channel_type: 'Channel::WebWidget' }),
    )
    const info = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).verify()

    expect(info.channelType).toBe('Channel::WebWidget')
  })

  /**
   * The `source_id` of the right inbox, not the first one in the list.
   *
   * A contact who has already written in by e-mail has one contact_inbox per
   * inbox; taking the first would open the conversation in the wrong place.
   */
  it('escolhe o source_id da caixa configurada', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        payload: [
          {
            id: 42,
            contact_inboxes: [
              { source_id: 'do-email', inbox: { id: 3 } },
              { source_id: 'do-whatsapp', inbox: { id: 7 } },
            ],
          },
        ],
      }),
    )

    const contact = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).ensureContact({ identifier: '5511999999999', phoneNumber: '+5511999999999', name: 'X' })

    expect(contact).toEqual({ contactId: 42, sourceId: 'do-whatsapp' })
  })

  it('ignora contato que não tem vínculo com a caixa configurada', async () => {
    let call = 0
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      call++
      // Search: finds a contact, but only in the wrong inbox.
      if (!init?.method || init.method === 'GET') {
        if (call === 1) {
          return response({
            payload: [{ id: 9, contact_inboxes: [{ source_id: 'outro', inbox: { id: 3 } }] }],
          })
        }
        return response({
          payload: [{ id: 9, contact_inboxes: [{ source_id: 'novo', inbox: { id: 7 } }] }],
        })
      }
      // Creating one returns the right link.
      return response({
        payload: { contact: { id: 9, contact_inboxes: [{ source_id: 'novo', inbox: { id: 7 } }] } },
      })
    })

    const contact = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).ensureContact({ identifier: '5511999999999', phoneNumber: '+5511999999999', name: 'X' })

    expect(contact.sourceId).toBe('novo')
  })

  /** A 422 on create is a race, not a failure: another process created it since the search. */
  it('sobrevive a contato criado por outro processo no meio do caminho', async () => {
    let search = 0
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ message: 'já existe' }, 422)
      search++
      if (search === 1) return response({ payload: [] })
      return response({
        payload: [{ id: 5, contact_inboxes: [{ source_id: 'tarde', inbox: { id: 7 } }] }],
      })
    })

    const contact = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).ensureContact({ identifier: '5511999999999', phoneNumber: '+5511999999999', name: 'X' })

    expect(contact.contactId).toBe(5)
  })

  it('manda o id do WhatsApp como source_id, que é o que corta o eco', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return response({ id: 900 })
    })

    await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).buildIncomingMessage({
      conversationId: '12',
      content: 'olá',
      sourceId: 'wamid.ABC',
    })

    expect(body.message_type).toBe('incoming')
    expect(body.source_id).toBe('wamid.ABC')
  })

  it('separa erro de configuração de erro de disponibilidade', () => {
    expect(new ChatwootError(401, 'x').isPermanente).toBe(true)
    expect(new ChatwootError(404, 'x').isPermanente).toBe(true)
    // These are worth retrying: they belong to the other side, and they pass.
    expect(new ChatwootError(429, 'x').isPermanente).toBe(false)
    expect(new ChatwootError(503, 'x').isPermanente).toBe(false)
  })
})

describe('cliente do Typebot', () => {
  it('achata o richText em texto corrido', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        sessionId: 'sess-1',
        input: { type: 'text input' },
        messages: [
          {
            type: 'text',
            content: {
              richText: [
                { type: 'p', children: [{ text: 'Olá! ' }, { text: 'Tudo bem?' }] },
                { type: 'p', children: [{ text: 'Como posso ajudar?' }] },
              ],
            },
          },
        ],
      }),
    )

    const turn = await new TypebotClient(TYPEBOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).start('oi')

    expect(turn.texts).toEqual(['Olá! Tudo bem?\nComo posso ajudar?'])
    expect(turn.sessionId).toBe('sess-1')
    expect(turn.awaitingReply).toBe(true)
  })

  /** With no `input`, the flow is over — and the next message starts from scratch. */
  it('reconhece fluxo encerrado', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        sessionId: 'sess-2',
        messages: [{ type: 'text', content: { richText: [{ children: [{ text: 'Tchau!' }] }] } }],
      }),
    )

    const turn = await new TypebotClient(TYPEBOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).start()

    expect(turn.awaitingReply).toBe(false)
  })

  it('mídia vira a URL, em vez de sumir', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        sessionId: 's',
        input: {},
        messages: [{ type: 'image', content: { url: 'https://exemplo.com/foto.png' } }],
      }),
    )

    const turn = await new TypebotClient(TYPEBOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).start()

    expect(turn.texts).toEqual(['https://exemplo.com/foto.png'])
  })

  it('descarta mensagem sem conteúdo aproveitável', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ sessionId: 's', input: {}, messages: [{ type: 'embed', content: {} }] }),
    )

    const turn = await new TypebotClient(TYPEBOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).start()

    expect(turn.texts).toEqual([])
  })

  /**
   * A 404 on continueChat is a dead session on the other side, not an error.
   * Treating it as a failure would leave the contact mute forever.
   */
  it('marca sessão expirada como caso à parte', () => {
    expect(new TypebotError(404, 'x').sessaoExpirada).toBe(true)
    expect(new TypebotError(500, 'x').sessaoExpirada).toBe(false)
  })

  it('só manda o bearer quando há token', async () => {
    const withoutToken: Array<Record<string, string>> = []
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      withoutToken.push(init?.headers as Record<string, string>)
      return response({ sessionId: 's', messages: [] })
    })

    await new TypebotClient(TYPEBOT, { fetch: fetchImpl as unknown as typeof fetch }).start()
    expect(withoutToken[0]?.authorization).toBeUndefined()

    await new TypebotClient(
      { ...TYPEBOT, apiToken: 'token-do-typebot' },
      { fetch: fetchImpl as unknown as typeof fetch },
    ).start()
    expect(withoutToken[1]?.authorization).toBe('Bearer token-do-typebot')
  })
})

describe('link de compartilhamento do Typebot', () => {
  it('deriva endereço e id do fluxo', () => {
    expect(deriveFromLink('https://typebot.io/meu-fluxo')).toEqual({
      baseUrl: 'https://typebot.io',
      typebotId: 'meu-fluxo',
    })
  })

  it('funciona com instância própria', () => {
    expect(deriveFromLink('https://bot.minhaempresa.com.br/atendimento')).toEqual({
      baseUrl: 'https://bot.minhaempresa.com.br',
      typebotId: 'atendimento',
    })
  })

  it('tolera espaço e barra sobrando', () => {
    expect(deriveFromLink('  https://typebot.io/meu-fluxo  ').typebotId).toBe('meu-fluxo')
  })

  /**
   * The likeliest mistake for someone with Typebot open: copying from the
   * editor's address bar. Without this check the integration is accepted and
   * only fails later, on the first message from a real customer.
   */
  it('recusa a URL do editor, explicando onde está a certa', () => {
    expect(() => deriveFromLink('https://app.typebot.io/typebots/abc123/edit')).toThrow(
      /editor link/i,
    )
  })

  it('recusa endereço sem fluxo', () => {
    expect(() => deriveFromLink('https://typebot.io')).toThrow(/flow id/i)
  })

  it('recusa o que não é URL', () => {
    expect(() => deriveFromLink('meu-fluxo')).toThrow(/URL/i)
  })
})

describe('descoberta no Chatwoot', () => {
  /**
   * The `accountId` is buried in the Chatwoot URL, and asking someone to copy
   * it from there is the first thing that stalls adoption. The token already
   * knows it.
   */
  it('lista as contas que o token alcança', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return response({
        accounts: [
          { id: 1, name: 'Minha Empresa', role: 'administrator' },
          { id: 2, name: 'Cliente X', role: 'agent' },
        ],
      })
    })

    const accounts = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).accounts()

    // The profile does not live under /accounts/{id} — it is the one absolute path.
    expect(urls[0]).toBe('https://chat.exemplo.com/api/v1/profile')
    expect(accounts).toEqual([
      { id: 1, name: 'Minha Empresa', role: 'administrator' },
      { id: 2, name: 'Cliente X', role: 'agent' },
    ])
  })

  it('descarta conta sem id em vez de estourar', async () => {
    const fetchImpl = vi.fn(async () => response({ accounts: [{ name: 'sem id' }, { id: 3 }] }))

    const accounts = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).accounts()

    expect(accounts).toEqual([{ id: 3, name: 'Conta 3', role: 'agent' }])
  })

  it('lista as caixas com o tipo, para o painel marcar as que não servem', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        payload: [
          { id: 7, name: 'WhatsApp', channel_type: 'Channel::Api' },
          { id: 8, name: 'Site', channel_type: 'Channel::WebWidget' },
        ],
      }),
    )

    const inboxes = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).inboxes()

    expect(inboxes).toEqual([
      { id: 7, name: 'WhatsApp', channelType: 'Channel::Api' },
      { id: 8, name: 'Site', channelType: 'Channel::WebWidget' },
    ])
  })

  /**
   * Creating the inbox and going back to Chatwoot to paste the URL were the two
   * steps that made most people give up. One call handles both.
   */
  it('cria a caixa já com o webhook apontado', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return response({ id: 12, name: 'WhatsApp (AWAH)' })
    })

    const created = await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).createInboxFor('WhatsApp (AWAH)', 'https://gateway/webhooks/chatwoot/abc/token')

    expect(created).toEqual({ id: 12, name: 'WhatsApp (AWAH)' })
    expect(body.channel).toEqual({
      type: 'api',
      webhook_url: 'https://gateway/webhooks/chatwoot/abc/token',
    })
  })

  it('corrige o webhook de uma caixa que já existia', async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return response({ id: 7 })
    })

    await new ChatwootClient(CHATWOOT, {
      fetch: fetchImpl as unknown as typeof fetch,
    }).setInboxWebhook(7, 'https://gateway/webhooks/chatwoot/abc/token')

    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toContain('/accounts/1/inboxes/7')
  })

  it('propaga 403 para a rota poder falar de permissão', async () => {
    const fetchImpl = vi.fn(async () => response({ message: 'sem permissão' }, 403))

    await expect(
      new ChatwootClient(CHATWOOT, { fetch: fetchImpl as unknown as typeof fetch }).createInboxFor(
        'x',
        'https://gateway/hook',
      ),
    ).rejects.toMatchObject({ status: 403, isPermanente: true })
  })
})
