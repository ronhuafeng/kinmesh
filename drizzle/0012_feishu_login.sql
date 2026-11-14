CREATE TABLE `login_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `humans` ADD `email` text;--> statement-breakpoint
CREATE UNIQUE INDEX `humans_email_unique` ON `humans` (`email`);--> statement-breakpoint
ALTER TABLE `humans` DROP COLUMN `password_hash`;