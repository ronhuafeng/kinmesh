ALTER TABLE "memberships" ADD COLUMN "notify_kinds" text[] DEFAULT '{reply,blocked,decide,task,mention}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "forward_after_ms" bigint;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "notify_hours" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "forward_at" bigint;--> statement-breakpoint
CREATE INDEX "notification_forward" ON "notifications" USING btree ("forward_at");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "membership_notify_kinds" CHECK ("memberships"."notify_kinds" <@ ARRAY['reply','blocked','decide','task','mention','message']::text[]);--> statement-breakpoint
-- Each person keeps what their level meant: everything, what concerns them, or nothing.
UPDATE "memberships" SET "notify_kinds" = CASE "notify" WHEN 'all' THEN ARRAY['reply','blocked','decide','task','mention','message']::text[] WHEN 'off' THEN ARRAY[]::text[] ELSE ARRAY['reply','blocked','decide','task','mention']::text[] END;
