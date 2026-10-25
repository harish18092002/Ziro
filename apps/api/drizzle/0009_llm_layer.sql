ALTER TYPE "public"."harness" ADD VALUE 'single-shot';--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"key" char(64) PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"harness" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_proposals" DROP CONSTRAINT "agent_proposals_degraded_known";--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "outcome" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cached" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "est_cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_degraded_known" CHECK ("agent_proposals"."degraded" is null or "agent_proposals"."degraded" in ('model_unavailable', 'model_rejected', 'invalid_reply', 'tool_budget', 'token_budget', 'time_budget', 'context', 'refused', 'quota_exhausted'));--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_outcome_known" CHECK ("llm_calls"."outcome" in ('ok', 'fell_back', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'BILLING', 'AUTH', 'TIMEOUT', 'SERVER', 'BAD_REQUEST', 'SAFETY_BLOCKED', 'MALFORMED'));--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_error_kind_known" CHECK ("llm_calls"."error_kind" is null or "llm_calls"."error_kind" in ('RATE_LIMITED', 'QUOTA_EXHAUSTED', 'BILLING', 'AUTH', 'TIMEOUT', 'SERVER', 'BAD_REQUEST', 'SAFETY_BLOCKED', 'MALFORMED'));