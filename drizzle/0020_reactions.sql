CREATE TABLE "message_reactions" (
	"message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"human_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "message_reactions_message_id_human_id_emoji_pk" PRIMARY KEY("message_id","human_id","emoji"),
	CONSTRAINT "message_reaction_emoji" CHECK ("message_reactions"."emoji" IN ('👍','👀','✅','🎉','❤️','😄'))
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_channel_id_messages_id_channel_id_fk" FOREIGN KEY ("message_id","channel_id") REFERENCES "public"."messages"("id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_reaction_channel" ON "message_reactions" USING btree ("channel_id","message_id");--> statement-breakpoint
-- Open views see a reaction come and go.
CREATE TRIGGER message_reactions_announce AFTER INSERT OR DELETE ON message_reactions
  FOR EACH STATEMENT EXECUTE FUNCTION kinmesh_announce();
