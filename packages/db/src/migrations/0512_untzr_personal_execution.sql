ALTER TABLE "adapter_auth_sessions" ADD COLUMN "integration_scope" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "untzr_execution" jsonb;