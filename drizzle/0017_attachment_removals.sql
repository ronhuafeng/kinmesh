CREATE TABLE "attachment_removals" (
	"attachment_id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"removed_by" text NOT NULL,
	"removed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment_unplacings" (
	"attachment_id" text PRIMARY KEY NOT NULL,
	"directory" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_removals" ADD CONSTRAINT "attachment_removals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_removals" ADD CONSTRAINT "attachment_removals_removed_by_humans_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_removals" ADD CONSTRAINT "attachment_removals_message_id_channel_id_messages_id_channel_id_fk" FOREIGN KEY ("message_id","channel_id") REFERENCES "public"."messages"("id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_removal_message" ON "attachment_removals" USING btree ("message_id");--> statement-breakpoint
-- Who removed which file is kept as it was written.
CREATE TRIGGER attachment_removal_immutable BEFORE UPDATE OR DELETE ON attachment_removals
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable attachment removal');
--> statement-breakpoint
CREATE TRIGGER attachment_removals_announce AFTER INSERT ON attachment_removals
  FOR EACH STATEMENT EXECUTE FUNCTION kinmesh_announce();
