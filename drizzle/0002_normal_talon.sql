CREATE TABLE `agent_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`team_id` text NOT NULL,
	`kind` text NOT NULL,
	`author` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_json" CHECK(json_valid("agent_audit"."author") AND json_valid("agent_audit"."detail"))
);
--> statement-breakpoint
CREATE TABLE `agent_correlations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`team_id` text NOT NULL,
	`reference_key` text NOT NULL,
	`reference` text NOT NULL,
	`provider_session_id` text,
	`invocation_id` text,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "correlation_reference_json" CHECK(json_valid("agent_correlations"."reference")),
	CONSTRAINT "correlation_author_json" CHECK(json_valid("agent_correlations"."author"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correlation_execution_owner` ON `agent_correlations` (`team_id`,`reference_key`);--> statement-breakpoint
CREATE TABLE `agent_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`team_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`scopes` text NOT NULL,
	`issued_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`issued_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grant_hash_length" CHECK(length("agent_grants"."token_hash") = 64),
	CONSTRAINT "grant_scopes_json" CHECK(json_valid("agent_grants"."scopes"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_grants_token_hash_unique` ON `agent_grants` (`token_hash`);--> statement-breakpoint
CREATE TABLE `agent_runtime_events` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text NOT NULL,
	`state` text NOT NULL,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`correlation_id`) REFERENCES `agent_correlations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runtime_state" CHECK("agent_runtime_events"."state" IN ('unknown','active','waiting','succeeded','failed','stopped'))
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`capabilities` text NOT NULL,
	`preferences` text NOT NULL,
	`memory_location` text,
	`lifecycle` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_name_length" CHECK(length(trim("agents"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "agent_role" CHECK("agents"."role" IN ('developer','reviewer','assistant')),
	CONSTRAINT "agent_lifecycle" CHECK("agents"."lifecycle" IN ('active','disabled')),
	CONSTRAINT "agent_capabilities_json" CHECK(json_valid("agents"."capabilities")),
	CONSTRAINT "agent_preferences_json" CHECK(json_valid("agents"."preferences")),
	CONSTRAINT "agent_memory_bound" CHECK("agents"."memory_location" IS NULL OR length("agents"."memory_location") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_identity` ON `agents` (`id`,`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_name` ON `agents` (`team_id`,`name`);--> statement-breakpoint
CREATE TRIGGER agent_identity_immutable BEFORE UPDATE OF id, team_id, created_at ON agents BEGIN SELECT RAISE(ABORT, 'immutable agent identity'); END;
--> statement-breakpoint
CREATE TRIGGER correlation_immutable_update BEFORE UPDATE ON agent_correlations BEGIN SELECT RAISE(ABORT, 'immutable correlation'); END;
--> statement-breakpoint
CREATE TRIGGER correlation_immutable_delete BEFORE DELETE ON agent_correlations BEGIN SELECT RAISE(ABORT, 'immutable correlation'); END;
--> statement-breakpoint
CREATE TRIGGER audit_immutable_update BEFORE UPDATE ON agent_audit BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;
--> statement-breakpoint
CREATE TRIGGER audit_immutable_delete BEFORE DELETE ON agent_audit BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;
--> statement-breakpoint
CREATE TRIGGER runtime_event_immutable_update BEFORE UPDATE ON agent_runtime_events BEGIN SELECT RAISE(ABORT, 'immutable runtime event'); END;
--> statement-breakpoint
CREATE TRIGGER runtime_event_immutable_delete BEFORE DELETE ON agent_runtime_events BEGIN SELECT RAISE(ABORT, 'immutable runtime event'); END;
--> statement-breakpoint
CREATE TRIGGER grant_binding_immutable BEFORE UPDATE OF id, agent_id, team_id, token_hash, scopes, issued_by, created_at ON agent_grants BEGIN SELECT RAISE(ABORT, 'immutable grant binding'); END;
--> statement-breakpoint
CREATE TRIGGER grant_revocation_final BEFORE UPDATE OF revoked_at ON agent_grants WHEN OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'revocation is final'); END;
