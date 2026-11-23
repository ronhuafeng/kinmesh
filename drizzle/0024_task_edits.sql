-- A task's acceptor may say again what is asked (title, description,
-- criteria); where it lives, who made it and who decides never change.
DROP TRIGGER task_contract_immutable ON tasks;--> statement-breakpoint
CREATE TRIGGER task_contract_immutable BEFORE UPDATE ON tasks
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.position IS DISTINCT FROM OLD.position
    OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
    OR NEW.creator IS DISTINCT FROM OLD.creator OR NEW.acceptor_human_id IS DISTINCT FROM OLD.acceptor_human_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  EXECUTE FUNCTION kinmesh_refuse('immutable task contract');
