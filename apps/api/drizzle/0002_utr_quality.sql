CREATE TYPE "public"."utr_quality" AS ENUM('exact', 'rejoined', 'repaired', 'truncated');--> statement-breakpoint
ALTER TABLE "bank_lines" ADD COLUMN "utr_quality" "utr_quality";--> statement-breakpoint
ALTER TABLE "bank_lines" ADD CONSTRAINT "bank_lines_utr_quality_in_step" CHECK (("bank_lines"."utr" is null) = ("bank_lines"."utr_quality" is null));