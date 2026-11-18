ALTER TABLE "channels" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channel_visibility" CHECK ("channels"."visibility" IN ('public', 'private'));--> statement-breakpoint
-- A channel stays what it was made as; only who may look in it changes.
DROP TRIGGER channels_immutable ON channels;--> statement-breakpoint
CREATE TRIGGER channels_immutable BEFORE DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');--> statement-breakpoint
CREATE TRIGGER channel_identity_immutable BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.name IS DISTINCT FROM OLD.name OR NEW.position IS DISTINCT FROM OLD.position)
  EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');--> statement-breakpoint
-- The channel everyone joins on their first sign-in is the team's own.
UPDATE "channels" SET "visibility" = 'public' WHERE "name" = 'general';
