ALTER TABLE "agent_inbox" ADD COLUMN "stop_requested_at" bigint;
--> statement-breakpoint
-- A person's request to stop a delivery is kept once made.
CREATE OR REPLACE FUNCTION kinmesh_inbox_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.root_id IS DISTINCT FROM OLD.root_id
    OR NEW.depth IS DISTINCT FROM OLD.depth OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
    OR NEW.position IS DISTINCT FROM OLD.position OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.launch IS NOT NULL AND NEW.launch IS DISTINCT FROM OLD.launch AND (
      NEW.launch IS NULL OR OLD.reference IS NOT NULL
      OR EXISTS (SELECT 1 FROM execution_operations
        WHERE actor = 'inbox-agent:' || OLD.agent_id AND operation_key = 'inbox:' || OLD.id
          AND (phase <> 'rejected' OR rejection IS DISTINCT FROM 'gone'))
      OR (OLD.operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM execution_operations
        WHERE id = OLD.operation_id AND phase = 'rejected' AND rejection = 'gone'))))
    OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id)
    OR (OLD.reference IS NOT NULL AND NEW.reference IS DISTINCT FROM OLD.reference)
    OR (OLD.stop_requested_at IS NOT NULL AND NEW.stop_requested_at IS DISTINCT FROM OLD.stop_requested_at)
    OR OLD.state IN ('acked', 'expired')
  THEN
    RAISE EXCEPTION 'immutable inbox contract' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
