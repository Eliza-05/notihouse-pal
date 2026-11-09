ALTER TYPE "public"."proposal_application_action" ADD VALUE 'create_recurring_obligation';--> statement-breakpoint
ALTER TYPE "public"."proposal_application_action" ADD VALUE 'update_obligation_schedule';--> statement-breakpoint
ALTER TYPE "public"."proposal_application_action" ADD VALUE 'update_occurrence_details';--> statement-breakpoint
ALTER TYPE "public"."proposal_application_action" ADD VALUE 'create_recurring_rental';--> statement-breakpoint
ALTER TABLE "proposal_applications" ALTER COLUMN "obligation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "proposal_applications" ALTER COLUMN "occurrence_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD COLUMN "rental_id" uuid;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_rental_owner_fk" FOREIGN KEY ("rental_id","owner_id") REFERENCES "public"."rentals"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applications" ADD CONSTRAINT "proposal_applications_exactly_one_resource" CHECK ((
        ("proposal_applications"."obligation_id" IS NOT NULL AND "proposal_applications"."occurrence_id" IS NOT NULL AND "proposal_applications"."rental_id" IS NULL)
        OR ("proposal_applications"."obligation_id" IS NOT NULL AND "proposal_applications"."occurrence_id" IS NULL AND "proposal_applications"."rental_id" IS NULL)
        OR ("proposal_applications"."obligation_id" IS NULL AND "proposal_applications"."occurrence_id" IS NULL AND "proposal_applications"."rental_id" IS NOT NULL)
      ));