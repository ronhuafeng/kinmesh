CREATE TABLE `inbox_bindings` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action
);
