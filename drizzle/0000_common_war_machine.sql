CREATE TABLE `bootstrap` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`completed_at` text NOT NULL,
	CONSTRAINT "one_bootstrap" CHECK("bootstrap"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_name_length" CHECK(length(trim("channels"."name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_team_name` ON `channels` (`team_id`,`name`);--> statement-breakpoint
CREATE TABLE `humans` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	CONSTRAINT "username_length" CHECK(length("humans"."username") BETWEEN 3 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `humans_username_unique` ON `humans` (`username`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`human_id` text NOT NULL,
	`team_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`human_id`, `team_id`),
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "valid_role" CHECK("memberships"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT "team_name_length" CHECK(length(trim("teams"."name")) BETWEEN 1 AND 80)
);
