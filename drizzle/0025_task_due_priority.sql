ALTER TABLE "tasks" ADD COLUMN "due" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_priority" CHECK ("tasks"."priority" IN ('high', 'normal', 'low'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_due" CHECK ("tasks"."due" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');