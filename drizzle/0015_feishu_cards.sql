ALTER TABLE "notifications" ADD COLUMN "card_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "card" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "card_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_card" ON "notifications" USING btree ("card_open");