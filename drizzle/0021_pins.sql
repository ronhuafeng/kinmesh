CREATE TABLE "channel_pins" (
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"pinned_by" text NOT NULL,
	"pinned_at" bigint NOT NULL,
	CONSTRAINT "channel_pins_channel_id_message_id_pk" PRIMARY KEY("channel_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_pinned_by_humans_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pins" ADD CONSTRAINT "channel_pins_message_id_channel_id_messages_id_channel_id_fk" FOREIGN KEY ("message_id","channel_id") REFERENCES "public"."messages"("id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Open views see a pin come and go.
CREATE TRIGGER channel_pins_announce AFTER INSERT OR DELETE ON channel_pins
  FOR EACH STATEMENT EXECUTE FUNCTION kinmesh_announce();
