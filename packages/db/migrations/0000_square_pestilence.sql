CREATE TYPE "public"."engine_type" AS ENUM('baileys', 'cloud_api', 'wwebjs', 'whatsmeow');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('viewer', 'operator', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'played', 'failed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'reaction', 'poll', 'system');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('queued', 'held', 'sending', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."risk_action" AS ENUM('allowed', 'delayed', 'held', 'throttled', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."session_event_type" AS ENUM('connecting', 'connected', 'disconnected', 'pairing_requested', 'paired', 'logged_out', 'lease_acquired', 'lease_lost', 'error');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('created', 'pairing', 'connecting', 'connected', 'disconnected', 'logged_out', 'banned');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivering', 'delivered', 'retrying', 'dead');--> statement-breakpoint
CREATE TABLE "message_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"status" "message_status" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_status_unique" UNIQUE("message_id","status")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"engine_message_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"type" "message_type" NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"from_jid" text,
	"to_jid" text,
	"body" text,
	"media_ref" text,
	"media_mime_type" text,
	"media_size" integer,
	"content_expires_at" timestamp with time zone,
	"outbox_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_engine_id_key" UNIQUE("org_id","session_id","engine_message_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_message_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"type" "message_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_reason" text,
	"last_error" text,
	"engine_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_client_message_key" UNIQUE("org_id","client_message_id")
);
--> statement-breakpoint
CREATE TABLE "session_auth" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"creds" text NOT NULL,
	"keys" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"type" "session_event_type" NOT NULL,
	"raw_code" integer,
	"cause" text,
	"node_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"engine" "engine_type" DEFAULT 'baileys' NOT NULL,
	"status" "session_status" DEFAULT 'created' NOT NULL,
	"phone_number" text,
	"owner_node_id" text,
	"lease_expires_at" timestamp with time zone,
	"paired_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"last_disconnected_at" timestamp with time zone,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_org_name_key" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "metrics_hourly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid,
	"bucket" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"dims" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_hourly_key" UNIQUE NULLS NOT DISTINCT("org_id","session_id","bucket","metric")
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"outbox_id" uuid,
	"action" "risk_action" NOT NULL,
	"score" integer NOT NULL,
	"reason" text NOT NULL,
	"budget" jsonb,
	"delay_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"role" "member_role" DEFAULT 'operator' NOT NULL,
	"session_scope" uuid[],
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_key" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_user_key" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer,
	"response_body" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] NOT NULL,
	"session_scope" uuid[],
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_outbox_id_outbox_messages_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth" ADD CONSTRAINT "session_auth_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_hourly" ADD CONSTRAINT "metrics_hourly_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_hourly" ADD CONSTRAINT "metrics_hourly_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_outbox_id_outbox_messages_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_status_message_idx" ON "message_status_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_chat_idx" ON "messages" USING btree ("org_id","chat_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_session_time_idx" ON "messages" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_retention_idx" ON "messages" USING btree ("content_expires_at");--> statement-breakpoint
CREATE INDEX "outbox_dispatch_idx" ON "outbox_messages" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_chat_order_idx" ON "outbox_messages" USING btree ("session_id","chat_id","created_at");--> statement-breakpoint
CREATE INDEX "session_events_session_idx" ON "session_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_events_org_idx" ON "session_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_org_idx" ON "sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_lease_idx" ON "sessions" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "metrics_hourly_lookup_idx" ON "metrics_hourly" USING btree ("org_id","metric","bucket");--> statement-breakpoint
CREATE INDEX "risk_events_session_idx" ON "risk_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_org_idx" ON "risk_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_expires_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_dispatch_idx" ON "webhook_deliveries" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("org_id");