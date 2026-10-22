ALTER TYPE "public"."verifier_status" ADD VALUE 'not_applicable';--> statement-breakpoint
CREATE TABLE "audit_event_records" (
	"audit_event_id" bigint NOT NULL,
	"record_type" "record_type" NOT NULL,
	"record_id" uuid NOT NULL,
	CONSTRAINT "audit_event_records_audit_event_id_record_type_record_id_pk" PRIMARY KEY("audit_event_id","record_type","record_id")
);
--> statement-breakpoint
ALTER TABLE "rzp_payments" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "rzp_refunds" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_items" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_event_records" ADD CONSTRAINT "audit_event_records_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_records_record_idx" ON "audit_event_records" USING btree ("record_id","audit_event_id");--> statement-breakpoint
-- audit_event_records is append-only like audit_events (CLAUDE.md section 4.7): the timeline of a
-- record must not be editable after the fact. The same caveat as migration 0001 applies: a table
-- owner can still drop the trigger, so the app must not connect as the owner in production.
CREATE FUNCTION "audit_event_records_forbid_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'audit_event_records is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_event_records_no_update_delete"
	BEFORE UPDATE OR DELETE ON "audit_event_records"
	FOR EACH ROW EXECUTE FUNCTION "audit_event_records_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "audit_event_records_no_truncate"
	BEFORE TRUNCATE ON "audit_event_records"
	FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_records_forbid_change"();
