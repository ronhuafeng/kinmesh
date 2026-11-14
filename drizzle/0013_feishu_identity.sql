DROP INDEX `humans_email_unique`;--> statement-breakpoint
ALTER TABLE `humans` ADD `feishu_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `humans_feishu_id_unique` ON `humans` (`feishu_id`);