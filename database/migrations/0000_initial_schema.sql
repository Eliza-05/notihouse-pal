CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'api', 'workflow', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('received', 'processing', 'awaiting_human', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."case_type" AS ENUM('household_obligation', 'rent_collection', 'contract_review');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('active', 'expired', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('invoice', 'contract', 'payment_receipt', 'voice_note', 'other');--> statement-breakpoint
CREATE TYPE "public"."hitl_decision_type" AS ENUM('data_confirmation', 'conflict_resolution', 'reminder_approval', 'contract_review', 'other');--> statement-breakpoint
CREATE TYPE "public"."hitl_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."input_source" AS ENUM('form', 'document', 'gmail', 'voice');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'claimed', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."link_validation_status" AS ENUM('pending', 'validated', 'rejected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."obligation_category" AS ENUM('water', 'electricity', 'gas', 'internet', 'mobile', 'administration', 'other');--> statement-breakpoint
CREATE TYPE "public"."obligation_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('pending', 'overdue', 'paid', 'attended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."proposal_review_status" AS ENUM('pending_review', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."proposal_source" AS ENUM('llm', 'ocr', 'stt', 'user');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."recurrence_frequency" AS ENUM('monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual');--> statement-breakpoint
CREATE TYPE "public"."rent_charge_status" AS ENUM('expected', 'pending', 'overdue', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rental_status" AS ENUM('active', 'suspended', 'ended');--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_auth_id" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_external_auth_id_unique" UNIQUE("external_auth_id")
);
--> statement-breakpoint
CREATE TABLE "provider_payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"url" text NOT NULL,
	"validation_status" "link_validation_status" DEFAULT 'pending' NOT NULL,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_payment_links_provider_url_unique" UNIQUE("provider_id","url"),
	CONSTRAINT "provider_payment_links_https" CHECK ("provider_payment_links"."url" ~ '^https://'),
	CONSTRAINT "provider_payment_links_validated_at" CHECK (("provider_payment_links"."validation_status" = 'validated') = ("provider_payment_links"."validated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "providers_slug_format" CHECK ("providers"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"description" text,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_owner_name_unique" UNIQUE("owner_id","name"),
	CONSTRAINT "properties_id_owner_unique" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "obligation_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(14, 2),
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"due_date" date NOT NULL,
	"status" "occurrence_status" DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmation_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligation_occurrences_period_unique" UNIQUE("obligation_id","period_start"),
	CONSTRAINT "obligation_occurrences_period_order" CHECK ("obligation_occurrences"."period_end" >= "obligation_occurrences"."period_start"),
	CONSTRAINT "obligation_occurrences_amount_non_negative" CHECK ("obligation_occurrences"."amount" >= 0),
	CONSTRAINT "obligation_occurrences_currency_format" CHECK ("obligation_occurrences"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "obligation_occurrences_confirmation" CHECK (("obligation_occurrences"."status" IN ('paid', 'attended')) = ("obligation_occurrences"."confirmed_at" IS NOT NULL AND "obligation_occurrences"."confirmed_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid,
	"provider_id" uuid,
	"provider_name" text NOT NULL,
	"concept" text NOT NULL,
	"category" "obligation_category" NOT NULL,
	"expected_amount" numeric(14, 2),
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"frequency" "recurrence_frequency" DEFAULT 'monthly' NOT NULL,
	"due_day" smallint,
	"reminder_days_before" smallint DEFAULT 3 NOT NULL,
	"starts_on" date,
	"status" "obligation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligations_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "obligations_expected_amount_non_negative" CHECK ("obligations"."expected_amount" >= 0),
	CONSTRAINT "obligations_currency_format" CHECK ("obligations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "obligations_due_day_range" CHECK ("obligations"."due_day" BETWEEN 1 AND 31),
	CONSTRAINT "obligations_reminder_days_range" CHECK ("obligations"."reminder_days_before" BETWEEN 0 AND 60)
);
--> statement-breakpoint
CREATE TABLE "rent_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rental_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"expected_amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"due_date" date NOT NULL,
	"status" "rent_charge_status" DEFAULT 'expected' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmation_evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_charges_period_unique" UNIQUE("rental_id","period_start"),
	CONSTRAINT "rent_charges_period_order" CHECK ("rent_charges"."period_end" >= "rent_charges"."period_start"),
	CONSTRAINT "rent_charges_expected_amount_positive" CHECK ("rent_charges"."expected_amount" > 0),
	CONSTRAINT "rent_charges_currency_format" CHECK ("rent_charges"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "rent_charges_confirmation" CHECK (("rent_charges"."status" = 'received') = ("rent_charges"."confirmed_at" IS NOT NULL AND "rent_charges"."confirmed_by" IS NOT NULL AND "rent_charges"."confirmation_evidence" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rentals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_alias" text,
	"expected_amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"due_day" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"status" "rental_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rentals_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "rentals_id_property_owner_unique" UNIQUE("id","property_id","owner_id"),
	CONSTRAINT "rentals_expected_amount_positive" CHECK ("rentals"."expected_amount" > 0),
	CONSTRAINT "rentals_currency_format" CHECK ("rentals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "rentals_due_day_range" CHECK ("rentals"."due_day" BETWEEN 1 AND 31),
	CONSTRAINT "rentals_date_order" CHECK ("rentals"."ends_on" >= "rentals"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"type" "document_type" NOT NULL,
	"source" "input_source" NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text,
	"storage_key" text NOT NULL,
	"sha256" char(64),
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "documents_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "documents_sha256_format" CHECK ("documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_mime_type_format" CHECK ("documents"."mime_type" ~ '^[a-z]+/[a-z0-9.+-]+$')
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"rental_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"notice_period_days" smallint,
	"status" "contract_status" DEFAULT 'active' NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "contracts_date_order" CHECK ("contracts"."ends_on" >= "contracts"."starts_on"),
	CONSTRAINT "contracts_notice_period_range" CHECK ("contracts"."notice_period_days" BETWEEN 0 AND 365)
);
--> statement-breakpoint
CREATE TABLE "case_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" "proposal_source" NOT NULL,
	"proposed_data" jsonb NOT NULL,
	"evidence" jsonb,
	"confidence" numeric(4, 3),
	"document_id" uuid,
	"review_status" "proposal_review_status" DEFAULT 'pending_review' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_proposals_case_version_unique" UNIQUE("case_id","version"),
	CONSTRAINT "case_proposals_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "case_proposals_version_positive" CHECK ("case_proposals"."version" >= 1),
	CONSTRAINT "case_proposals_confidence_range" CHECK ("case_proposals"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "case_proposals_review" CHECK (("case_proposals"."review_status" IN ('accepted', 'rejected')) = ("case_proposals"."reviewed_at" IS NOT NULL AND "case_proposals"."reviewed_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" "case_type" NOT NULL,
	"source" "input_source" NOT NULL,
	"status" "case_status" DEFAULT 'received' NOT NULL,
	"obligation_id" uuid,
	"rental_id" uuid,
	"contract_id" uuid,
	"status_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_correlation_id_unique" UNIQUE("correlation_id"),
	CONSTRAINT "cases_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "cases_single_subject" CHECK (num_nonnulls("cases"."obligation_id", "cases"."rental_id", "cases"."contract_id") <= 1),
	CONSTRAINT "cases_failed_reason" CHECK ("cases"."status" <> 'failed' OR "cases"."status_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "hitl_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"proposal_id" uuid,
	"assigned_to" uuid NOT NULL,
	"decision_type" "hitl_decision_type" NOT NULL,
	"status" "hitl_status" DEFAULT 'pending' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"decision" jsonb,
	"responded_at" timestamp with time zone,
	"evidence_reference" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hitl_requests_due_after_created" CHECK ("hitl_requests"."due_at" > "hitl_requests"."created_at"),
	CONSTRAINT "hitl_requests_decision" CHECK (("hitl_requests"."status" IN ('approved', 'rejected')) = ("hitl_requests"."decision" IS NOT NULL AND "hitl_requests"."responded_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "workflow_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"result" jsonb,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "workflow_jobs_job_type_format" CHECK ("workflow_jobs"."job_type" ~ '^[a-z][a-z0-9_.]*$'),
	CONSTRAINT "workflow_jobs_attempts_range" CHECK ("workflow_jobs"."attempts" >= 0 AND "workflow_jobs"."max_attempts" >= 1 AND "workflow_jobs"."attempts" <= "workflow_jobs"."max_attempts"),
	CONSTRAINT "workflow_jobs_lease" CHECK (("workflow_jobs"."status" = 'claimed') = ("workflow_jobs"."locked_by" IS NOT NULL AND "workflow_jobs"."locked_until" IS NOT NULL)),
	CONSTRAINT "workflow_jobs_completed_at" CHECK (("workflow_jobs"."status" = 'completed') = ("workflow_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" uuid,
	"owner_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"component" text NOT NULL,
	"action" text NOT NULL,
	"result" "audit_result" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_reference" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_payment_links" ADD CONSTRAINT "provider_payment_links_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_occurrences" ADD CONSTRAINT "obligation_occurrences_confirmed_by_profiles_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_occurrences" ADD CONSTRAINT "obligation_occurrences_obligation_owner_fk" FOREIGN KEY ("obligation_id","owner_id") REFERENCES "public"."obligations"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_property_owner_fk" FOREIGN KEY ("property_id","owner_id") REFERENCES "public"."properties"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_confirmed_by_profiles_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_rental_owner_fk" FOREIGN KEY ("rental_id","owner_id") REFERENCES "public"."rentals"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_property_owner_fk" FOREIGN KEY ("property_id","owner_id") REFERENCES "public"."properties"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "public"."cases"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_property_owner_fk" FOREIGN KEY ("property_id","owner_id") REFERENCES "public"."properties"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_rental_property_owner_fk" FOREIGN KEY ("rental_id","property_id","owner_id") REFERENCES "public"."rentals"("id","property_id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_document_owner_fk" FOREIGN KEY ("document_id","owner_id") REFERENCES "public"."documents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_proposals" ADD CONSTRAINT "case_proposals_reviewed_by_profiles_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_proposals" ADD CONSTRAINT "case_proposals_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "public"."cases"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_proposals" ADD CONSTRAINT "case_proposals_document_owner_fk" FOREIGN KEY ("document_id","owner_id") REFERENCES "public"."documents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_obligation_owner_fk" FOREIGN KEY ("obligation_id","owner_id") REFERENCES "public"."obligations"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_rental_owner_fk" FOREIGN KEY ("rental_id","owner_id") REFERENCES "public"."rentals"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_contract_owner_fk" FOREIGN KEY ("contract_id","owner_id") REFERENCES "public"."contracts"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_assigned_to_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "public"."cases"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_proposal_owner_fk" FOREIGN KEY ("proposal_id","owner_id") REFERENCES "public"."case_proposals"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_payment_links_provider_idx" ON "provider_payment_links" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "obligation_occurrences_owner_due_idx" ON "obligation_occurrences" USING btree ("owner_id","due_date");--> statement-breakpoint
CREATE INDEX "obligation_occurrences_open_due_idx" ON "obligation_occurrences" USING btree ("due_date") WHERE "obligation_occurrences"."status" IN ('pending', 'overdue');--> statement-breakpoint
CREATE INDEX "obligations_owner_idx" ON "obligations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "obligations_property_idx" ON "obligations" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "obligations_provider_idx" ON "obligations" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "rent_charges_owner_due_idx" ON "rent_charges" USING btree ("owner_id","due_date");--> statement-breakpoint
CREATE INDEX "rent_charges_open_due_idx" ON "rent_charges" USING btree ("due_date") WHERE "rent_charges"."status" IN ('expected', 'pending', 'overdue');--> statement-breakpoint
CREATE INDEX "rentals_owner_idx" ON "rentals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "rentals_property_idx" ON "rentals" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "documents_case_idx" ON "documents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "documents_owner_sha256_idx" ON "documents" USING btree ("owner_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_external_message_idx" ON "documents" USING btree ("external_message_id");--> statement-breakpoint
CREATE INDEX "contracts_owner_ends_idx" ON "contracts" USING btree ("owner_id","ends_on");--> statement-breakpoint
CREATE INDEX "contracts_property_idx" ON "contracts" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "contracts_rental_idx" ON "contracts" USING btree ("rental_id");--> statement-breakpoint
CREATE INDEX "case_proposals_document_idx" ON "case_proposals" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "cases_owner_status_idx" ON "cases" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "cases_obligation_idx" ON "cases" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "cases_rental_idx" ON "cases" USING btree ("rental_id");--> statement-breakpoint
CREATE INDEX "cases_contract_idx" ON "cases" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "hitl_requests_case_idx" ON "hitl_requests" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "hitl_requests_assignee_status_idx" ON "hitl_requests" USING btree ("assigned_to","status");--> statement-breakpoint
CREATE INDEX "hitl_requests_pending_due_idx" ON "hitl_requests" USING btree ("due_at") WHERE "hitl_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "workflow_jobs_case_idx" ON "workflow_jobs" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "workflow_jobs_pending_available_idx" ON "workflow_jobs" USING btree ("available_at") WHERE "workflow_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "workflow_jobs_claimed_lease_idx" ON "workflow_jobs" USING btree ("locked_until") WHERE "workflow_jobs"."status" = 'claimed';--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_events_owner_occurred_idx" ON "audit_events" USING btree ("owner_id","occurred_at");--> statement-breakpoint
-- Añadido manualmente (Drizzle Kit no genera triggers): audit_events es append-only.
CREATE FUNCTION "public"."audit_events_reject_modification"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events es append-only: % no está permitido', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_reject_update_delete" BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."audit_events_reject_modification"();--> statement-breakpoint
CREATE TRIGGER "audit_events_reject_truncate" BEFORE TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_events_reject_modification"();