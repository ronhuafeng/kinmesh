ALTER TABLE "channels" ADD COLUMN "direct_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_team_direct" ON "channels" USING btree ("team_id","direct_key");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channel_direct_private" CHECK ("channels"."direct_key" IS NULL OR "channels"."visibility" = 'private');--> statement-breakpoint
-- Whose conversation a channel is never changes either.
DROP TRIGGER channel_identity_immutable ON channels;--> statement-breakpoint
CREATE TRIGGER channel_identity_immutable BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.position IS DISTINCT FROM OLD.position OR NEW.direct_key IS DISTINCT FROM OLD.direct_key)
  EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
