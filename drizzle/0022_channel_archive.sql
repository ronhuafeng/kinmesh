ALTER TABLE "channels" ADD COLUMN "archived_at" bigint;--> statement-breakpoint
-- A channel can be named again (its folder keeps its first name) and
-- archived; its ID, team and position never change.
DROP TRIGGER channel_identity_immutable ON channels;--> statement-breakpoint
CREATE TRIGGER channel_identity_immutable BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.position IS DISTINCT FROM OLD.position)
  EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
