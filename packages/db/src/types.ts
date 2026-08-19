import type {
  desiredState,
  engineType,
  memberRole,
  messageDirection,
  messageStatus,
  messageType,
  outboxStatus,
  riskAction,
  sessionEventType,
  sessionStatus,
  webhookDeliveryStatus,
} from './schema/enums'

/**
 * Tipos TypeScript derivados dos enums do banco. Derivar em vez de redeclarar
 * garante que schema e código não saiam de sincronia em silêncio: acrescentar um
 * valor no enum do Postgres quebra o `switch` exaustivo no TypeScript.
 */
export type MemberRole = (typeof memberRole.enumValues)[number]
export type DesiredState = (typeof desiredState.enumValues)[number]
export type EngineType = (typeof engineType.enumValues)[number]
export type SessionStatus = (typeof sessionStatus.enumValues)[number]
export type SessionEventType = (typeof sessionEventType.enumValues)[number]
export type OutboxStatus = (typeof outboxStatus.enumValues)[number]
export type MessageDirection = (typeof messageDirection.enumValues)[number]
export type MessageStatus = (typeof messageStatus.enumValues)[number]
export type MessageType = (typeof messageType.enumValues)[number]
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatus.enumValues)[number]
export type RiskAction = (typeof riskAction.enumValues)[number]
