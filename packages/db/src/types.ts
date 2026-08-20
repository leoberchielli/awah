import type {
  desiredState,
  engineType,
  integrationKind,
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
 * TypeScript types derived from the database enums. Deriving instead of
 * redeclaring guarantees schema and code never fall out of sync in silence:
 * adding a value to the Postgres enum breaks the exhaustive `switch` in
 * TypeScript.
 */
export type MemberRole = (typeof memberRole.enumValues)[number]
export type DesiredState = (typeof desiredState.enumValues)[number]
export type EngineType = (typeof engineType.enumValues)[number]
export type IntegrationKind = (typeof integrationKind.enumValues)[number]
export type SessionStatus = (typeof sessionStatus.enumValues)[number]
export type SessionEventType = (typeof sessionEventType.enumValues)[number]
export type OutboxStatus = (typeof outboxStatus.enumValues)[number]
export type MessageDirection = (typeof messageDirection.enumValues)[number]
export type MessageStatus = (typeof messageStatus.enumValues)[number]
export type MessageType = (typeof messageType.enumValues)[number]
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatus.enumValues)[number]
export type RiskAction = (typeof riskAction.enumValues)[number]
