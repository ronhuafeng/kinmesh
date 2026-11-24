CREATE TABLE "github_connections" (
	"team_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"installation_id" bigint,
	"account" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_created_by_humans_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;