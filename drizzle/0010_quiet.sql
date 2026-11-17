CREATE TABLE "agent_mutes" (
	"human_id" text NOT NULL,
	"team_id" text NOT NULL,
	"agent_id" text NOT NULL,
	CONSTRAINT "agent_mutes_human_id_agent_id_pk" PRIMARY KEY("human_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "channel_participants" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "paused_until" bigint;--> statement-breakpoint
ALTER TABLE "agent_mutes" ADD CONSTRAINT "agent_mutes_human_id_team_id_memberships_human_id_team_id_fk" FOREIGN KEY ("human_id","team_id") REFERENCES "public"."memberships"("human_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mutes" ADD CONSTRAINT "agent_mutes_agent_id_team_id_agents_id_team_id_fk" FOREIGN KEY ("agent_id","team_id") REFERENCES "public"."agents"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Muting an agent changes what people see (unread), so it is announced.
CREATE TRIGGER agent_mutes_announce AFTER INSERT OR UPDATE OR DELETE ON agent_mutes FOR EACH STATEMENT EXECUTE FUNCTION kinmesh_announce();
