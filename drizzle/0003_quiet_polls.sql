-- Only what people see is announced. The execution journal is the worker's
-- bookkeeping, shown nowhere. A delivery is announced when it is added or
-- removed, or when its state, reason or reply changes; a claim, a lease or
-- the next time it is looked at changes nothing on screen.
DROP TRIGGER execution_operations_announce ON execution_operations;
--> statement-breakpoint
DROP TRIGGER agent_inbox_announce ON agent_inbox;
--> statement-breakpoint
CREATE TRIGGER agent_inbox_announce AFTER INSERT OR DELETE ON agent_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION kinmesh_announce();
--> statement-breakpoint
CREATE TRIGGER agent_inbox_shown AFTER UPDATE ON agent_inbox
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.result_message_id IS DISTINCT FROM NEW.result_message_id)
  EXECUTE FUNCTION kinmesh_announce();
