ALTER TABLE "channel_participants" ADD COLUMN "read_position" integer;--> statement-breakpoint
-- People start having read what was already there: only what comes next is new.
UPDATE "channel_participants" AS p SET "read_position" = (
  SELECT max(m."position") FROM "messages" AS m WHERE m."channel_id" = p."channel_id"
) WHERE p."human_id" IS NOT NULL;
