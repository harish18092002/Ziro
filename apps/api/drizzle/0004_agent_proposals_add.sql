CREATE TYPE "public"."agent_verdict" AS ENUM('MATCH_PROPOSED', 'EXPLAINED_NO_MATCH', 'NEEDS_HUMAN');--> statement-breakpoint
CREATE TYPE "public"."suggested_action" AS ENUM('ACCEPT_MATCH', 'RAISE_RAZORPAY_TICKET', 'REFUND_CUSTOMER', 'ADJUST_LEDGER', 'CHASE_SETTLEMENT', 'NONE');--> statement-breakpoint
ALTER TABLE "agent_proposals" ALTER COLUMN "claimed_residual_paise" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "verdict" "agent_verdict" NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "confidence_permille" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "suggested_action" "suggested_action" NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "draft_journal_entry" jsonb;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "harness_findings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposals_exception_attempt_uq" ON "agent_proposals" USING btree ("exception_id","attempt");--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_attempt_positive" CHECK ("agent_proposals"."attempt" >= 1);--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_confidence_range" CHECK ("agent_proposals"."confidence_permille" >= 0 and "agent_proposals"."confidence_permille" <= 1000);--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_cache_nonneg" CHECK ("llm_calls"."cache_read_tokens" >= 0 and "llm_calls"."cache_write_tokens" >= 0);