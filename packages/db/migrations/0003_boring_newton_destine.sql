CREATE TYPE "public"."desired_state" AS ENUM('running', 'stopped');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "desired_state" "desired_state" DEFAULT 'stopped' NOT NULL;