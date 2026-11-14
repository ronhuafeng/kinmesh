-- Rules the schema cannot say: records that never change or go, and the one
-- channel every committed change is announced on. A broken rule is an
-- integrity violation (SQLSTATE 23000), refused like any constraint.

CREATE FUNCTION kinmesh_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = '23000';
END $$;
--> statement-breakpoint

-- Identities and evidence about agents.
CREATE TRIGGER agent_identity_immutable BEFORE UPDATE OF id, team_id, created_at ON agents
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  EXECUTE FUNCTION kinmesh_refuse('immutable agent identity');
--> statement-breakpoint
CREATE TRIGGER correlation_immutable BEFORE UPDATE OR DELETE ON agent_correlations
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable correlation');
--> statement-breakpoint
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON agent_audit
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable audit');
--> statement-breakpoint
CREATE TRIGGER runtime_event_immutable BEFORE UPDATE OR DELETE ON agent_runtime_events
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable runtime event');
--> statement-breakpoint
CREATE TRIGGER grant_binding_immutable BEFORE UPDATE ON agent_grants
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.scopes IS DISTINCT FROM OLD.scopes OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  EXECUTE FUNCTION kinmesh_refuse('immutable grant binding');
--> statement-breakpoint
CREATE TRIGGER grant_revocation_final BEFORE UPDATE OF revoked_at ON agent_grants
  FOR EACH ROW WHEN (OLD.revoked_at IS NOT NULL)
  EXECUTE FUNCTION kinmesh_refuse('revocation is final');
--> statement-breakpoint

-- Communication is a record of what was said.
CREATE TRIGGER channels_immutable BEFORE UPDATE OR DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
--> statement-breakpoint
CREATE TRIGGER topics_immutable BEFORE UPDATE OR DELETE ON topics
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
--> statement-breakpoint
CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
--> statement-breakpoint
CREATE TRIGGER message_mentions_immutable BEFORE UPDATE OR DELETE ON message_mentions
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
--> statement-breakpoint
CREATE TRIGGER communication_outbox_immutable BEFORE UPDATE OR DELETE ON communication_outbox
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
--> statement-breakpoint
CREATE TRIGGER communication_operations_immutable BEFORE UPDATE OR DELETE ON communication_operations
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable communication fact');
--> statement-breakpoint

-- A task's contract never changes; its state moves one version at a time
-- until it is accepted or cancelled; its history stays.
CREATE TRIGGER task_contract_immutable BEFORE UPDATE ON tasks
  FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id OR NEW.position IS DISTINCT FROM OLD.position
    OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.topic_id IS DISTINCT FROM OLD.topic_id OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description OR NEW.criteria IS DISTINCT FROM OLD.criteria
    OR NEW.creator IS DISTINCT FROM OLD.creator OR NEW.acceptor_human_id IS DISTINCT FROM OLD.acceptor_human_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  EXECUTE FUNCTION kinmesh_refuse('immutable task contract');
--> statement-breakpoint
CREATE TRIGGER task_revision_guard BEFORE UPDATE ON tasks
  FOR EACH ROW WHEN (NEW.version <> OLD.version + 1 OR OLD.status IN ('accepted', 'cancelled'))
  EXECUTE FUNCTION kinmesh_refuse('invalid task revision');
--> statement-breakpoint
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable task history');
--> statement-breakpoint
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable task evidence');
--> statement-breakpoint
CREATE TRIGGER task_executions_immutable BEFORE UPDATE OR DELETE ON task_executions
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable task evidence');
--> statement-breakpoint

-- A delivery's source never changes. A frozen launch stays frozen once a
-- native operation may exist: an operation ID, a reference, or a journal
-- entry (written before dispatch); before that, it may be frozen again.
CREATE FUNCTION kinmesh_inbox_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.root_id IS DISTINCT FROM OLD.root_id
    OR NEW.depth IS DISTINCT FROM OLD.depth OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
    OR NEW.position IS DISTINCT FROM OLD.position OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR (OLD.launch IS NOT NULL AND NEW.launch IS DISTINCT FROM OLD.launch AND (
      NEW.launch IS NULL OR OLD.operation_id IS NOT NULL OR OLD.reference IS NOT NULL
      OR EXISTS (SELECT 1 FROM execution_operations
        WHERE actor = 'inbox-agent:' || OLD.agent_id AND operation_key = 'inbox:' || OLD.id)))
    OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id)
    OR (OLD.reference IS NOT NULL AND NEW.reference IS DISTINCT FROM OLD.reference)
    OR OLD.state IN ('acked', 'expired')
  THEN
    RAISE EXCEPTION 'immutable inbox contract' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inbox_source_immutable BEFORE UPDATE ON agent_inbox
  FOR EACH ROW EXECUTE FUNCTION kinmesh_inbox_contract();
--> statement-breakpoint
CREATE TRIGGER inbox_no_delete BEFORE DELETE ON agent_inbox
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('retained inbox');
--> statement-breakpoint
CREATE TRIGGER inbox_history_immutable BEFORE UPDATE OR DELETE ON inbox_history
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable inbox history');
--> statement-breakpoint
CREATE TRIGGER inbox_causes_immutable BEFORE UPDATE OR DELETE ON inbox_causes
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable inbox cause');
--> statement-breakpoint
CREATE TRIGGER inbox_results_immutable BEFORE UPDATE OR DELETE ON inbox_results
  FOR EACH ROW EXECUTE FUNCTION kinmesh_refuse('immutable inbox result');
--> statement-breakpoint

-- Every committed change to what people see is announced, once per
-- statement. Worker and Team MCP heartbeats, sessions and sign-ins under way
-- are not: they change nothing on screen by themselves.
CREATE FUNCTION kinmesh_announce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kinmesh_changes', '');
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'humans', 'teams', 'memberships', 'channels', 'channel_participants',
    'topics', 'messages', 'message_mentions', 'communication_outbox',
    'agents', 'agent_avatars', 'agent_grants', 'agent_correlations',
    'agent_audit', 'agent_runtime_events', 'tasks', 'task_events',
    'task_executions', 'agent_inbox', 'inbox_results', 't3_connections',
    'managed_bindings', 'execution_operations'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION kinmesh_announce()',
      name || '_announce', name);
  END LOOP;
END $$;
