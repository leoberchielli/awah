CREATE TABLE "session_auth_keys" (
	"session_id" uuid NOT NULL,
	"key_type" text NOT NULL,
	"key_id" text NOT NULL,
	"value" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_auth_keys_session_id_key_type_key_id_pk" PRIMARY KEY("session_id","key_type","key_id")
);
--> statement-breakpoint
ALTER TABLE "session_auth_keys" ADD CONSTRAINT "session_auth_keys_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_auth_keys_session_idx" ON "session_auth_keys" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "session_auth" DROP COLUMN "keys";