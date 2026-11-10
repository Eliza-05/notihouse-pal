CREATE TYPE "public"."alert_resolution" AS ENUM('resource_closed', 'superseded', 'no_longer_applicable');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_state" AS ENUM('active', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('obligation_due_soon', 'obligation_overdue', 'rent_charge_due_soon', 'rent_charge_overdue', 'contract_ending_soon', 'contract_end_passed', 'hitl_pending', 'hitl_due_soon', 'hitl_overdue');--> statement-breakpoint
CREATE TYPE "public"."proposal_application_action" AS ENUM('create_obligation_occurrence', 'create_obligation_with_occurrence');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" "alert_type" NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"occurrence_id" uuid,
	"rent_charge_id" uuid,
	"contract_id" uuid,
	"hitl_request_id" uuid,
	"relevant_date" date NOT NULL,
	"dedup_key" text NOT NULL,
	"state" "alert_state" DEFAULT 'active' NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_reason" "alert_resolution",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_owner_dedup_unique" UNIQUE("owner_id","dedup_key"),
	CONSTRAINT "alerts_single_resource" CHECK (num_nonnulls("alerts"."occurrence_id", "alerts"."rent_charge_id", "alerts"."contract_id", "alerts"."hitl_request_id") = 1),
	CONSTRAINT "alerts_dedup_key_length" CHECK (length("alerts"."dedup_key") <= 200),
	CONSTRAINT "alerts_dismissed" CHECK (("alerts"."state" = 'dismissed') = ("alerts"."dismissed_at" IS NOT NULL)),
	CONSTRAINT "alerts_resolved" CHECK (("alerts"."state" = 'resolved') = ("alerts"."resolved_at" IS NOT NULL AND "alerts"."resolution_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "proposal_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"hitl_request_id" uuid NOT NULL,
	"action" "proposal_application_action" NOT NULL,
	"obligation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"applied_by" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_applications_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "proposal_applications_occurrence_unique" UNIQUE("occurrence_id"),
	CONSTRAINT "proposal_applications_applied_by_owner" CHECK ("proposal_applications"."applied_by" = "proposal_applications"."owner_id")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_occurrence_id_obligation_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."obligation_occurrences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rent_charge_id_rent_charges_id_fk" FOREIGN KEY ("rent_charge_id") REFERENCES "public"."rent_charges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_hitl_request_id_hitl_requests_id_fk" FOREIGN KEY ("hitl_request_id") REFERENCES "public"."hitl_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_hitl_request_id_hitl_requests_id_fk" FOREIGN KEY ("hitl_request_id") REFERENCES "public"."hitl_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_occurrence_id_obligation_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."obligation_occurrences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_applied_by_profiles_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_proposal_owner_fk" FOREIGN KEY ("proposal_id","owner_id") REFERENCES "public"."case_proposals"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "public"."cases"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_obligation_owner_fk" FOREIGN KEY ("obligation_id","owner_id") REFERENCES "public"."obligations"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_owner_created_idx" ON "alerts" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_occurrence_unique" ON "alerts" USING btree ("occurrence_id") WHERE "alerts"."state" = 'active' AND "alerts"."occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_rent_charge_unique" ON "alerts" USING btree ("rent_charge_id") WHERE "alerts"."state" = 'active' AND "alerts"."rent_charge_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_contract_unique" ON "alerts" USING btree ("contract_id") WHERE "alerts"."state" = 'active' AND "alerts"."contract_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_hitl_request_unique" ON "alerts" USING btree ("hitl_request_id") WHERE "alerts"."state" = 'active' AND "alerts"."hitl_request_id" IS NOT NULL;