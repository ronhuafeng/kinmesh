ALTER TABLE "agent_mutes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_mutes" CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "membership_notify_kinds";--> statement-breakpoint
ALTER TABLE "channel_participants" DROP COLUMN "muted";--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "notify_kinds";