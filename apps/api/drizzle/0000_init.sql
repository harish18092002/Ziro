CREATE TYPE "public"."actor" AS ENUM('rule', 'agent', 'verifier', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."bank_direction" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('open', 'proposed', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."harness" AS ENUM('loop', 'agent-sdk');--> statement-breakpoint
CREATE TYPE "public"."match_basis" AS ENUM('rule', 'agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."match_group_kind" AS ENUM('order', 'payout');--> statement-breakpoint
CREATE TYPE "public"."match_group_status" AS ENUM('proposed', 'accepted', 'rejected', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."match_tier" AS ENUM('T1', 'T2', 'T3', 'T4');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'authorized', 'captured', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."razorpay_source" AS ENUM('synthetic', 'testmode');--> statement-breakpoint
CREATE TYPE "public"."reason_code" AS ENUM('FEE_GST_DEDUCTION', 'BATCHED_SETTLEMENT', 'PARTIAL_REFUND_NETTED', 'FULL_REFUND', 'CHARGEBACK_ADJUSTMENT', 'DUPLICATE_PAYMENT', 'LEDGER_WITHOUT_PAYMENT', 'PAYMENT_WITHOUT_LEDGER', 'UTR_MISSING_OR_GARBLED', 'LEDGER_AMOUNT_EDITED', 'TIMEZONE_DATE_SHIFT', 'SETTLEMENT_DELAYED', 'FEE_OVERCHARGE', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('csv', 'synthetic', 'razorpay_testmode');--> statement-breakpoint
CREATE TYPE "public"."record_type" AS ENUM('ledger_entry', 'rzp_payment', 'rzp_refund', 'rzp_settlement', 'bank_line');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."reviewer_kind" AS ENUM('human', 'auto_accept');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('created', 'ingesting', 'matching', 'investigating', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."settlement_item_type" AS ENUM('payment', 'refund', 'transfer', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('created', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."verifier_status" AS ENUM('pending', 'passed', 'rejected');--> statement-breakpoint
CREATE TABLE "agent_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"llm_call_id" uuid,
	"reason_code" "reason_code" NOT NULL,
	"links" jsonb NOT NULL,
	"claimed_residual_paise" bigint NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"verifier_status" "verifier_status" DEFAULT 'pending' NOT NULL,
	"verifier_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "actor" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "record_source" NOT NULL,
	"source_ref" text NOT NULL,
	"import_hash" char(64) NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_date" date NOT NULL,
	"direction" "bank_direction" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"narration" text NOT NULL,
	"utr" text,
	"balance_paise" bigint,
	CONSTRAINT "bank_lines_import_hash_sha256" CHECK ("bank_lines"."import_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bank_lines_amount_nonneg" CHECK ("bank_lines"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "record_source" NOT NULL,
	"source_ref" text NOT NULL,
	"import_hash" char(64) NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_ref" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"business_date" date NOT NULL,
	"customer_ref" text,
	"memo" text,
	CONSTRAINT "ledger_entries_amount_nonneg" CHECK ("ledger_entries"."amount_paise" >= 0),
	CONSTRAINT "ledger_entries_import_hash_sha256" CHECK ("ledger_entries"."import_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"exception_id" uuid,
	"model" text NOT NULL,
	"harness" "harness" NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"latency_ms" integer NOT NULL,
	"prompt_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_prompt_hash_sha256" CHECK ("llm_calls"."prompt_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "llm_calls_nonneg" CHECK ("llm_calls"."tokens_in" >= 0 and "llm_calls"."tokens_out" >= 0 and "llm_calls"."cost_usd" >= 0 and "llm_calls"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "match_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "match_group_kind" NOT NULL,
	"status" "match_group_status" NOT NULL,
	"basis" "match_basis" NOT NULL,
	"tier" "match_tier",
	"reason_code" "reason_code",
	"residual_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_groups_id_status_uq" UNIQUE("id","status"),
	CONSTRAINT "match_groups_accepted_reconciles" CHECK ("match_groups"."status" <> 'accepted' or "match_groups"."residual_paise" = 0)
);
--> statement-breakpoint
CREATE TABLE "match_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"group_status" "match_group_status" NOT NULL,
	"ledger_entry_id" uuid,
	"payment_id" uuid,
	"refund_id" uuid,
	"settlement_id" uuid,
	"bank_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_links_exactly_one_record" CHECK (num_nonnulls("match_links"."ledger_entry_id", "match_links"."payment_id", "match_links"."refund_id", "match_links"."settlement_id", "match_links"."bank_line_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "recon_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"reason_code" "reason_code" NOT NULL,
	"status" "exception_status" DEFAULT 'open' NOT NULL,
	"subject_type" "record_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_at_stake_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "run_status" DEFAULT 'created' NOT NULL,
	"razorpay_source" "razorpay_source" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "recon_runs_period_ordered" CHECK ("recon_runs"."period_start" <= "recon_runs"."period_end")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"reviewer_kind" "reviewer_kind" NOT NULL,
	"reviewer" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rzp_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "record_source" NOT NULL,
	"source_ref" text NOT NULL,
	"import_hash" char(64) NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rzp_id" text NOT NULL,
	"rzp_order_id" text,
	"receipt" text,
	"amount_paise" bigint NOT NULL,
	"fee_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"amount_refunded_paise" bigint DEFAULT 0 NOT NULL,
	"method" text NOT NULL,
	"status" "payment_status" NOT NULL,
	"captured" boolean NOT NULL,
	"rzp_created_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	CONSTRAINT "rzp_payments_import_hash_sha256" CHECK ("rzp_payments"."import_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rzp_payments_amount_nonneg" CHECK ("rzp_payments"."amount_paise" >= 0),
	CONSTRAINT "rzp_payments_fee_nonneg" CHECK ("rzp_payments"."fee_paise" >= 0),
	CONSTRAINT "rzp_payments_tax_within_fee" CHECK ("rzp_payments"."tax_paise" >= 0 and "rzp_payments"."tax_paise" <= "rzp_payments"."fee_paise"),
	CONSTRAINT "rzp_payments_refunded_within_amount" CHECK ("rzp_payments"."amount_refunded_paise" >= 0 and "rzp_payments"."amount_refunded_paise" <= "rzp_payments"."amount_paise")
);
--> statement-breakpoint
CREATE TABLE "rzp_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "record_source" NOT NULL,
	"source_ref" text NOT NULL,
	"import_hash" char(64) NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rzp_id" text NOT NULL,
	"rzp_payment_id" text NOT NULL,
	"payment_id" uuid,
	"amount_paise" bigint NOT NULL,
	"status" text NOT NULL,
	"rzp_created_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	CONSTRAINT "rzp_refunds_import_hash_sha256" CHECK ("rzp_refunds"."import_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rzp_refunds_amount_nonneg" CHECK ("rzp_refunds"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rzp_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "record_source" NOT NULL,
	"source_ref" text NOT NULL,
	"import_hash" char(64) NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rzp_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"fees_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"utr" text,
	"status" "settlement_status" NOT NULL,
	"rzp_created_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	CONSTRAINT "rzp_settlements_import_hash_sha256" CHECK ("rzp_settlements"."import_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rzp_settlements_amount_nonneg" CHECK ("rzp_settlements"."amount_paise" >= 0),
	CONSTRAINT "rzp_settlements_fees_nonneg" CHECK ("rzp_settlements"."fees_paise" >= 0 and "rzp_settlements"."tax_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "record_source" NOT NULL,
	"source_ref" text NOT NULL,
	"import_hash" char(64) NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"item_type" "settlement_item_type" NOT NULL,
	"rzp_entity_id" text NOT NULL,
	"rzp_payment_id" text,
	"rzp_order_id" text,
	"payment_id" uuid,
	"refund_id" uuid,
	"amount_paise" bigint NOT NULL,
	"fee_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"debit_paise" bigint NOT NULL,
	"credit_paise" bigint NOT NULL,
	"settled_at" timestamp with time zone,
	"description" text,
	CONSTRAINT "settlement_items_import_hash_sha256" CHECK ("settlement_items"."import_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "settlement_items_amounts_nonneg" CHECK ("settlement_items"."amount_paise" >= 0 and "settlement_items"."fee_paise" >= 0 and "settlement_items"."tax_paise" >= 0 and "settlement_items"."debit_paise" >= 0 and "settlement_items"."credit_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_exception_id_recon_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."recon_exceptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_lines" ADD CONSTRAINT "bank_lines_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_exception_id_recon_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."recon_exceptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_groups" ADD CONSTRAINT "match_groups_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_links" ADD CONSTRAINT "match_links_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_links" ADD CONSTRAINT "match_links_payment_id_rzp_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."rzp_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_links" ADD CONSTRAINT "match_links_refund_id_rzp_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."rzp_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_links" ADD CONSTRAINT "match_links_settlement_id_rzp_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."rzp_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_links" ADD CONSTRAINT "match_links_bank_line_id_bank_lines_id_fk" FOREIGN KEY ("bank_line_id") REFERENCES "public"."bank_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_links" ADD CONSTRAINT "match_links_group_fk" FOREIGN KEY ("group_id","group_status") REFERENCES "public"."match_groups"("id","status") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recon_exceptions" ADD CONSTRAINT "recon_exceptions_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_proposal_id_agent_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."agent_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rzp_payments" ADD CONSTRAINT "rzp_payments_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rzp_refunds" ADD CONSTRAINT "rzp_refunds_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rzp_refunds" ADD CONSTRAINT "rzp_refunds_payment_id_rzp_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."rzp_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rzp_settlements" ADD CONSTRAINT "rzp_settlements_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_rzp_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."rzp_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_payment_id_rzp_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."rzp_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_refund_id_rzp_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."rzp_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_proposals_exception_idx" ON "agent_proposals" USING btree ("exception_id");--> statement-breakpoint
CREATE INDEX "audit_events_run_idx" ON "audit_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_lines_run_source_ref_uq" ON "bank_lines" USING btree ("run_id","source_ref");--> statement-breakpoint
CREATE INDEX "bank_lines_run_utr_idx" ON "bank_lines" USING btree ("run_id","utr");--> statement-breakpoint
CREATE INDEX "bank_lines_run_date_amount_idx" ON "bank_lines" USING btree ("run_id","value_date","amount_paise");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_run_source_ref_uq" ON "ledger_entries" USING btree ("run_id","source_ref");--> statement-breakpoint
CREATE INDEX "ledger_entries_run_order_ref_idx" ON "ledger_entries" USING btree ("run_id","order_ref");--> statement-breakpoint
CREATE INDEX "llm_calls_run_idx" ON "llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "match_groups_run_idx" ON "match_groups" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_links_one_accepted_ledger_entry" ON "match_links" USING btree ("ledger_entry_id") WHERE "match_links"."group_status" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "match_links_one_accepted_payment" ON "match_links" USING btree ("payment_id") WHERE "match_links"."group_status" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "match_links_one_accepted_refund" ON "match_links" USING btree ("refund_id") WHERE "match_links"."group_status" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "match_links_one_accepted_settlement" ON "match_links" USING btree ("settlement_id") WHERE "match_links"."group_status" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "match_links_one_accepted_bank_line" ON "match_links" USING btree ("bank_line_id") WHERE "match_links"."group_status" = 'accepted';--> statement-breakpoint
CREATE INDEX "match_links_group_idx" ON "match_links" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recon_exceptions_run_subject_uq" ON "recon_exceptions" USING btree ("run_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "recon_exceptions_run_status_idx" ON "recon_exceptions" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_proposal_uq" ON "reviews" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_payments_run_source_ref_uq" ON "rzp_payments" USING btree ("run_id","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_payments_run_rzp_id_uq" ON "rzp_payments" USING btree ("run_id","rzp_id");--> statement-breakpoint
CREATE INDEX "rzp_payments_run_order_idx" ON "rzp_payments" USING btree ("run_id","rzp_order_id");--> statement-breakpoint
CREATE INDEX "rzp_payments_run_receipt_idx" ON "rzp_payments" USING btree ("run_id","receipt");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_refunds_run_source_ref_uq" ON "rzp_refunds" USING btree ("run_id","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_refunds_run_rzp_id_uq" ON "rzp_refunds" USING btree ("run_id","rzp_id");--> statement-breakpoint
CREATE INDEX "rzp_refunds_run_rzp_payment_idx" ON "rzp_refunds" USING btree ("run_id","rzp_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_settlements_run_source_ref_uq" ON "rzp_settlements" USING btree ("run_id","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_settlements_run_rzp_id_uq" ON "rzp_settlements" USING btree ("run_id","rzp_id");--> statement-breakpoint
CREATE INDEX "rzp_settlements_run_utr_idx" ON "rzp_settlements" USING btree ("run_id","utr");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_items_run_source_ref_uq" ON "settlement_items" USING btree ("run_id","source_ref");--> statement-breakpoint
CREATE INDEX "settlement_items_settlement_idx" ON "settlement_items" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "settlement_items_payment_idx" ON "settlement_items" USING btree ("payment_id");