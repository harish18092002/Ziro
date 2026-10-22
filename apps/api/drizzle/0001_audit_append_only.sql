-- audit_events is append-only (CLAUDE.md §4.7): reject UPDATE, DELETE and TRUNCATE at the database.
-- This stops the application. A table owner or superuser can still DROP/DISABLE a trigger, so the
-- app must connect as a role that does not own the table (see docs/DECISIONS.md, ADR-005).
CREATE FUNCTION "audit_events_forbid_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete"
	BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW EXECUTE FUNCTION "audit_events_forbid_change"();--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate"
	BEFORE TRUNCATE ON "audit_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_forbid_change"();
