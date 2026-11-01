-- A frozen launch stays immutable once a native operation may exist: an
-- operation ID, a reference, or a journal entry (written before dispatch).
-- Before that, it may be frozen again under the current T3 authority.
DROP TRIGGER inbox_source_immutable;--> statement-breakpoint
CREATE TRIGGER inbox_source_immutable BEFORE UPDATE ON agent_inbox
WHEN NEW.id != OLD.id OR NEW.event_id != OLD.event_id OR NEW.team_id != OLD.team_id
 OR NEW.channel_id != OLD.channel_id OR NEW.agent_id != OLD.agent_id OR NEW.root_id != OLD.root_id
 OR NEW.depth != OLD.depth OR NEW.task_id IS NOT OLD.task_id OR NEW.message_id IS NOT OLD.message_id
 OR NEW.topic_id IS NOT OLD.topic_id OR NEW.position != OLD.position OR NEW.expires_at != OLD.expires_at
 OR (OLD.launch IS NOT NULL AND NEW.launch IS NOT OLD.launch AND (
   NEW.launch IS NULL OR OLD.operation_id IS NOT NULL OR OLD.reference IS NOT NULL
   OR EXISTS (SELECT 1 FROM execution_operations
     WHERE actor = 'inbox-agent:' || OLD.agent_id AND operation_key = 'inbox:' || OLD.id)))
 OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id)
 OR (OLD.reference IS NOT NULL AND NEW.reference IS NOT OLD.reference)
 OR OLD.state IN ('acked','expired')
BEGIN SELECT RAISE(ABORT, 'immutable inbox contract'); END;
