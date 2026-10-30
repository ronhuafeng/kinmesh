ALTER TABLE `execution_operations` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `execution_operations` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `execution_operations` ADD `lease_until` integer DEFAULT 0 NOT NULL;