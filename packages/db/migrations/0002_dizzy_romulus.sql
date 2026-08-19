DROP INDEX "outbox_dispatch_idx";--> statement-breakpoint
DROP INDEX "outbox_chat_order_idx";--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_dispatch_idx" ON "outbox_messages" USING btree ("status","available_at","seq");--> statement-breakpoint
CREATE INDEX "outbox_chat_order_idx" ON "outbox_messages" USING btree ("session_id","chat_id","seq");