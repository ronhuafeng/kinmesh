CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"uploader" text NOT NULL,
	"operation_key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "attachment_upload" UNIQUE("uploader","channel_id","operation_key"),
	CONSTRAINT "attachment_size" CHECK ("attachments"."size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "message_body_bound";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_humans_id_fk" FOREIGN KEY ("uploader") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_channel_id_messages_id_channel_id_fk" FOREIGN KEY ("message_id","channel_id") REFERENCES "public"."messages"("id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_message" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachment_team" ON "attachments" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "attachment_sha256" ON "attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "attachment_unbound" ON "attachments" USING btree ("created_at") WHERE "attachments"."message_id" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_body_bound" CHECK (length("messages"."body") BETWEEN 0 AND 8000);