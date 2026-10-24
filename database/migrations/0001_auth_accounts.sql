CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_accounts_profile_id_unique" UNIQUE("profile_id"),
	CONSTRAINT "auth_accounts_email_unique" UNIQUE("email"),
	CONSTRAINT "auth_accounts_email_normalized" CHECK ("auth_accounts"."email" = lower(btrim("auth_accounts"."email"))),
	CONSTRAINT "auth_accounts_email_format" CHECK ("auth_accounts"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "auth_accounts_password_hash_argon2id" CHECK ("auth_accounts"."password_hash" LIKE '$argon2id$%')
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;