CREATE TABLE `agent_inbox` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`event_id` text NOT NULL,
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`root_id` text NOT NULL,
	`depth` integer NOT NULL,
	`task_id` text,
	`message_id` text,
	`topic_id` text,
	`state` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`next_attempt` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`launch` text,
	`operation_id` text,
	`reference` text,
	`result_message_id` text,
	`reason` text DEFAULT 'enqueued' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `communication_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_id`) REFERENCES `communication_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`,`team_id`) REFERENCES `channels`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`,`channel_id`) REFERENCES `tasks`(`id`,`channel_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`,`channel_id`) REFERENCES `messages`(`id`,`channel_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`,`channel_id`) REFERENCES `topics`(`id`,`channel_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_state" CHECK("agent_inbox"."state" IN ('ready','waiting','uncertain','acked','blocked','expired')),
	CONSTRAINT "inbox_counters" CHECK("agent_inbox"."generation" >= 0 AND "agent_inbox"."attempts" >= 0 AND "agent_inbox"."lease_until" >= 0 AND "agent_inbox"."depth" BETWEEN 0 AND 4),
	CONSTRAINT "inbox_claim" CHECK(("agent_inbox"."claim_token" IS NULL AND "agent_inbox"."lease_until"=0) OR ("agent_inbox"."claim_token" IS NOT NULL AND "agent_inbox"."lease_until">0)),
	CONSTRAINT "inbox_ack" CHECK(("agent_inbox"."state" = 'acked' AND "agent_inbox"."result_message_id" IS NOT NULL) OR ("agent_inbox"."state" != 'acked' AND "agent_inbox"."result_message_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_id_unique` ON `agent_inbox` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_event_target` ON `agent_inbox` (`event_id`,`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_chain_target` ON `agent_inbox` (`root_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `inbox_due` ON `agent_inbox` (`state`,`next_attempt`,`lease_until`);--> statement-breakpoint
CREATE INDEX `inbox_agent_order` ON `agent_inbox` (`agent_id`,`position`);--> statement-breakpoint
CREATE TABLE `inbox_causes` (
	`event_id` text PRIMARY KEY NOT NULL,
	`root_id` text NOT NULL,
	`depth` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `communication_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_id`) REFERENCES `communication_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_depth" CHECK("inbox_causes"."depth" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE `inbox_history` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `agent_inbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inbox_history_order` ON `inbox_history` (`delivery_id`,`position`);--> statement-breakpoint
CREATE TABLE `inbox_results` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`task_link_id` text,
	`result` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `agent_inbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`correlation_id`) REFERENCES `agent_correlations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_link_id`) REFERENCES `task_executions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_result_json" CHECK(json_valid("inbox_results"."result"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_results_message_id_unique` ON `inbox_results` (`message_id`);--> statement-breakpoint
CREATE TRIGGER inbox_source_immutable BEFORE UPDATE ON agent_inbox
WHEN NEW.id != OLD.id OR NEW.event_id != OLD.event_id OR NEW.team_id != OLD.team_id
 OR NEW.channel_id != OLD.channel_id OR NEW.agent_id != OLD.agent_id OR NEW.root_id != OLD.root_id
 OR NEW.depth != OLD.depth OR NEW.task_id IS NOT OLD.task_id OR NEW.message_id IS NOT OLD.message_id
 OR NEW.topic_id IS NOT OLD.topic_id OR NEW.position != OLD.position OR NEW.expires_at != OLD.expires_at
 OR (OLD.launch IS NOT NULL AND NEW.launch IS NOT OLD.launch)
 OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id)
 OR (OLD.reference IS NOT NULL AND NEW.reference IS NOT OLD.reference)
 OR OLD.state IN ('acked','expired')
BEGIN SELECT RAISE(ABORT, 'immutable inbox contract'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_no_delete BEFORE DELETE ON agent_inbox BEGIN SELECT RAISE(ABORT, 'retained inbox'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_history_no_update BEFORE UPDATE ON inbox_history BEGIN SELECT RAISE(ABORT, 'immutable inbox history'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_history_no_delete BEFORE DELETE ON inbox_history BEGIN SELECT RAISE(ABORT, 'retained inbox history'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_causes_no_update BEFORE UPDATE ON inbox_causes BEGIN SELECT RAISE(ABORT, 'immutable inbox cause'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_causes_no_delete BEFORE DELETE ON inbox_causes BEGIN SELECT RAISE(ABORT, 'retained inbox cause'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_results_no_update BEFORE UPDATE ON inbox_results BEGIN SELECT RAISE(ABORT, 'immutable inbox result'); END;
--> statement-breakpoint
CREATE TRIGGER inbox_results_no_delete BEFORE DELETE ON inbox_results BEGIN SELECT RAISE(ABORT, 'retained inbox result'); END;
