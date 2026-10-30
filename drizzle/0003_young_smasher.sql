CREATE TABLE `channel_participants` (
	`channel_id` text NOT NULL,
	`team_id` text NOT NULL,
	`member_key` text NOT NULL,
	`human_id` text,
	`agent_id` text,
	`state` text NOT NULL,
	PRIMARY KEY(`channel_id`, `member_key`),
	FOREIGN KEY (`channel_id`,`team_id`) REFERENCES `channels`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`,`team_id`) REFERENCES `memberships`(`human_id`,`team_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "participant_identity" CHECK(("channel_participants"."human_id" IS NOT NULL AND "channel_participants"."agent_id" IS NULL AND "channel_participants"."member_key" = 'human:' || "channel_participants"."human_id") OR ("channel_participants"."agent_id" IS NOT NULL AND "channel_participants"."human_id" IS NULL AND "channel_participants"."member_key" = 'agent:' || "channel_participants"."agent_id")),
	CONSTRAINT "participant_state" CHECK("channel_participants"."state" IN ('joined','left','removed'))
);
--> statement-breakpoint
CREATE INDEX `participant_visibility` ON `channel_participants` (`team_id`,`member_key`,`state`,`channel_id`);--> statement-breakpoint
CREATE TABLE `communication_operations` (
	`scope` text NOT NULL,
	`operation_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL,
	PRIMARY KEY(`scope`, `operation_key`)
);
--> statement-breakpoint
CREATE TABLE `communication_outbox` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`channel_id` text NOT NULL,
	`fact` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_fact_json" CHECK(json_valid("communication_outbox"."fact"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `communication_outbox_id_unique` ON `communication_outbox` (`id`);--> statement-breakpoint
CREATE INDEX `outbox_channel_order` ON `communication_outbox` (`channel_id`,`position`);--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`member_key` text NOT NULL,
	`target` text NOT NULL,
	PRIMARY KEY(`message_id`, `member_key`),
	FOREIGN KEY (`message_id`,`channel_id`) REFERENCES `messages`(`id`,`channel_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`,`member_key`) REFERENCES `channel_participants`(`channel_id`,`member_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`channel_id` text NOT NULL,
	`topic_id` text,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	`body` text NOT NULL,
	`source_message_id` text,
	`source_event_id` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`,`channel_id`) REFERENCES `topics`(`id`,`channel_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_body_bound" CHECK(length("messages"."body") BETWEEN 1 AND 8000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_channel_identity` ON `messages` (`id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `message_channel_timeline` ON `messages` (`channel_id`,`position`);--> statement-breakpoint
CREATE INDEX `message_topic_timeline` ON `messages` (`channel_id`,`topic_id`,`position`);--> statement-breakpoint
CREATE TABLE `topics` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "topic_title_bound" CHECK(length(trim("topics"."title")) BETWEEN 1 AND 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topics_id_unique` ON `topics` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `topic_channel_identity` ON `topics` (`id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `topic_timeline` ON `topics` (`channel_id`,`position`);--> statement-breakpoint
ALTER TABLE `channels` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE channels SET position = rowid;
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_position` ON `channels` (`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_id_team` ON `channels` (`id`,`team_id`);
--> statement-breakpoint
INSERT INTO channel_participants(channel_id,team_id,member_key,human_id,agent_id,state) SELECT c.id,c.team_id,'human:' || m.human_id,m.human_id,NULL,'joined' FROM channels c JOIN memberships m ON m.team_id=c.team_id WHERE m.role='owner';

--> statement-breakpoint
CREATE TRIGGER channels_immutable_update BEFORE UPDATE ON channels BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER channels_immutable_delete BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER topics_immutable_update BEFORE UPDATE ON topics BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER topics_immutable_delete BEFORE DELETE ON topics BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER messages_immutable_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER messages_immutable_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER message_mentions_immutable_update BEFORE UPDATE ON message_mentions BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER message_mentions_immutable_delete BEFORE DELETE ON message_mentions BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER communication_outbox_immutable_update BEFORE UPDATE ON communication_outbox BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER communication_outbox_immutable_delete BEFORE DELETE ON communication_outbox BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER communication_operations_immutable_update BEFORE UPDATE ON communication_operations BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;

--> statement-breakpoint
CREATE TRIGGER communication_operations_immutable_delete BEFORE DELETE ON communication_operations BEGIN SELECT RAISE(ABORT, 'immutable communication fact'); END;
