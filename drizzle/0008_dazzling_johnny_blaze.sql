CREATE TABLE `managed_bindings` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `t3_connections` (
	`team_id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`environment_id` text NOT NULL,
	`connected_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `team_mcp_presence` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE no action
);
