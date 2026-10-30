CREATE TABLE `task_events` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`event` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `communication_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_event_json" CHECK(json_valid("task_events"."event"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_events_id_unique` ON `task_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_revision_event` ON `task_events` (`task_id`,`version`);--> statement-breakpoint
CREATE INDEX `task_history_order` ON `task_events` (`task_id`,`position`);--> statement-breakpoint
CREATE TABLE `task_executions` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`reference_key` text NOT NULL,
	`reference` text NOT NULL,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_executions_id_unique` ON `task_executions` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_execution_reference` ON `task_executions` (`task_id`,`reference_key`);--> statement-breakpoint
CREATE INDEX `task_execution_order` ON `task_executions` (`task_id`,`position`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`topic_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`criteria` text NOT NULL,
	`creator` text NOT NULL,
	`acceptor_human_id` text NOT NULL,
	`state` text NOT NULL,
	`status` text NOT NULL,
	`owner_key` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`channel_id`,`team_id`) REFERENCES `channels`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`,`channel_id`) REFERENCES `topics`(`id`,`channel_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acceptor_human_id`,`team_id`) REFERENCES `memberships`(`human_id`,`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_version_positive" CHECK("tasks"."version">0),
	CONSTRAINT "task_valid_state" CHECK(json_valid("tasks"."state") AND json_extract("tasks"."state",'$.status') = "tasks"."status"),
	CONSTRAINT "task_owner_state" CHECK(("tasks"."owner_key" IS NULL AND json_extract("tasks"."state",'$.owner') IS NULL AND "tasks"."status" IN ('proposed','cancelled')) OR ("tasks"."owner_key" IS NOT NULL AND "tasks"."status" IN ('in-progress','review-requested','awaiting-human','rework-requested','accepted','cancelled') AND "tasks"."owner_key" = json_extract("tasks"."state",'$.owner.kind') || ':' || json_extract("tasks"."state",'$.owner.id')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_unique` ON `tasks` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_channel_identity` ON `tasks` (`id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `task_channel_order` ON `tasks` (`channel_id`,`position`);
--> statement-breakpoint
CREATE TRIGGER task_contract_immutable BEFORE UPDATE OF id,position,team_id,channel_id,topic_id,title,description,criteria,creator,acceptor_human_id,created_at ON tasks BEGIN SELECT RAISE(ABORT,'immutable task contract'); END;
--> statement-breakpoint
CREATE TRIGGER task_revision_guard BEFORE UPDATE ON tasks WHEN NEW.version != OLD.version+1 OR OLD.status IN ('accepted','cancelled') BEGIN SELECT RAISE(ABORT,'invalid task revision'); END;
--> statement-breakpoint
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'immutable task history'); END;

--> statement-breakpoint
CREATE TRIGGER task_events_immutable_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT,'immutable task evidence'); END;

--> statement-breakpoint
CREATE TRIGGER task_events_immutable_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT,'immutable task evidence'); END;

--> statement-breakpoint
CREATE TRIGGER task_executions_immutable_update BEFORE UPDATE ON task_executions BEGIN SELECT RAISE(ABORT,'immutable task evidence'); END;

--> statement-breakpoint
CREATE TRIGGER task_executions_immutable_delete BEFORE DELETE ON task_executions BEGIN SELECT RAISE(ABORT,'immutable task evidence'); END;
