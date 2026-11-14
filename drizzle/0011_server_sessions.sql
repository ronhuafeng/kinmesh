CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_human` ON `sessions` (`human_id`);