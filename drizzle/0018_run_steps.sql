ALTER TABLE "agent_inbox" ADD COLUMN "step" text;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD COLUMN "step_waiting" boolean DEFAULT false NOT NULL;