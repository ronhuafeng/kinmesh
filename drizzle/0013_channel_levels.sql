ALTER TABLE "notifications" DROP CONSTRAINT "notification_state";--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "forward_after_ms" SET DEFAULT 600000;--> statement-breakpoint
ALTER TABLE "channel_participants" ADD COLUMN "level" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_participants" ADD CONSTRAINT "participant_level" CHECK ("channel_participants"."level" IN ('mute','default','follow'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notification_state" CHECK ("notifications"."state" IN ('pending','sent','held','inapp'));--> statement-breakpoint
-- A muted channel stays muted; someone who wanted every message follows the
-- channels they are in; everyone else keeps the default.
UPDATE "channel_participants" AS p SET "level" = CASE
  WHEN p."muted" THEN 'mute'
  WHEN EXISTS (
    SELECT 1 FROM "memberships" AS m
    WHERE m."human_id" = p."human_id" AND m."team_id" = p."team_id"
      AND 'message' = ANY (m."notify_kinds")
  ) THEN 'follow'
  ELSE 'default'
END WHERE p."human_id" IS NOT NULL;--> statement-breakpoint
-- Feishu finds people ten minutes after what stays unread, unless they say otherwise.
UPDATE "memberships" SET "forward_after_ms" = 600000 WHERE "forward_after_ms" IS NULL;
