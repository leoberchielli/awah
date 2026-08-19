import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Papéis do RBAC, em ordem crescente de poder. A hierarquia numérica vive em
 * `apps/api/src/auth/rbac.ts` — este enum define apenas os valores aceitos pelo banco.
 */
export const memberRole = pgEnum('member_role', ['viewer', 'operator', 'admin', 'owner'])

/** Implementações do EngineAdapter (§5 da spec). */
export const engineType = pgEnum('engine_type', ['baileys', 'cloud_api', 'wwebjs', 'whatsmeow'])

/**
 * Ferramentas externas que o gateway alimenta.
 *
 * `chatwoot` é atendimento humano e fala nos dois sentidos; `typebot` é fluxo
 * automatizado e responde ao que chega. Eles não são exclusivos entre si: o
 * arranjo mais comum é o fluxo atender primeiro e passar para o humano quando
 * não dá conta.
 *
 * `http` é o escape: fala com qualquer coisa que aceite um POST e devolva JSON.
 * Existe para que plugar uma plataforma nova não dependa de alguém escrever um
 * conector dedicado aqui dentro — n8n, Make, uma função serverless ou o sistema
 * da casa entram por ele sem mudança de código.
 */
export const integrationKind = pgEnum('integration_kind', ['chatwoot', 'typebot', 'http'])

export const sessionStatus = pgEnum('session_status', [
  'created',
  'pairing',
  'connecting',
  'connected',
  'disconnected',
  'logged_out',
  'banned',
])

/**
 * Intenção do operador, separada do estado observado.
 *
 * `status` diz onde a sessão está; `desired_state` diz onde ela deveria estar.
 * A distinção é o que torna o failover possível sem adivinhação: quando um nó
 * morre, a sessão fica com status 'connected' e sem dono — e só é legítimo
 * assumi-la porque alguém pediu 'running'. Uma sessão que o operador parou tem
 * 'stopped' e não deve ser ressuscitada por ninguém.
 */
export const desiredState = pgEnum('desired_state', ['running', 'stopped'])

export const sessionEventType = pgEnum('session_event_type', [
  'connecting',
  'connected',
  'disconnected',
  'pairing_requested',
  'paired',
  'logged_out',
  'lease_acquired',
  'lease_lost',
  'error',
])

/**
 * Estados do outbox (§4.2). `held` é o estado que o motor de risco usa para
 * segurar uma mensagem sem descartá-la; `dead` é a DLQ.
 */
export const outboxStatus = pgEnum('outbox_status', [
  'queued',
  'held',
  'sending',
  'sent',
  'failed',
  'dead',
])

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])

/**
 * `stale` existe porque um ACK que nunca chega não é o mesmo que uma entrega
 * confirmada — o reconciliador marca stale em vez de mentir "delivered".
 */
export const messageStatus = pgEnum('message_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'stale',
])

export const messageType = pgEnum('message_type', [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'reaction',
  'poll',
  'system',
])

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'delivering',
  'delivered',
  'retrying',
  'dead',
])

/** Decisões do motor de risco (§4.1). `blocked` só ocorre com a sessão banida. */
export const riskAction = pgEnum('risk_action', [
  'allowed',
  'delayed',
  'held',
  'throttled',
  'blocked',
])
