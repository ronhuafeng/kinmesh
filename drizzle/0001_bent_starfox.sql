CREATE TABLE `execution_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`actor` text NOT NULL,
	`operation_key` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`tool` text NOT NULL,
	`payload` text NOT NULL,
	`phase` text NOT NULL,
	`reference` text,
	`rejection` text,
	CONSTRAINT "execution_phase" CHECK("execution_operations"."phase" IN ('prepared','dispatching','uncertain','known','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_operations_request_id_unique` ON `execution_operations` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_intent_scope` ON `execution_operations` (`scope`,`actor`,`operation_key`);