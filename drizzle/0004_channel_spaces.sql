CREATE TABLE "channel_spaces" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"directory" text NOT NULL,
	CONSTRAINT "channel_space_directory_name" CHECK ("channel_spaces"."directory" ~ '^[a-z0-9][a-z0-9-]{0,79}$')
);
--> statement-breakpoint
ALTER TABLE "channel_spaces" ADD CONSTRAINT "channel_spaces_channel_id_team_id_channels_id_team_id_fk" FOREIGN KEY ("channel_id","team_id") REFERENCES "public"."channels"("id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_space_directory" ON "channel_spaces" USING btree ("directory");