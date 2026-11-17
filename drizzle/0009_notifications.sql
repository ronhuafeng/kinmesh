CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"channel_id" text NOT NULL,
	"topic_id" text,
	"message_id" text,
	"task_id" text,
	"task_version" integer,
	"delivery_id" text,
	"state" text NOT NULL,
	"due_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "notification_once" UNIQUE("human_id","source"),
	CONSTRAINT "notification_kind" CHECK ("notifications"."kind" IN ('reply','blocked','decide','task','mention','message')),
	CONSTRAINT "notification_state" CHECK ("notifications"."state" IN ('pending','sent'))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "notify" text DEFAULT 'mine' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_hash_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_due" ON "notifications" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "push_subscription_human" ON "push_subscriptions" USING btree ("human_id");--> statement-breakpoint
CREATE INDEX "push_subscription_session" ON "push_subscriptions" USING btree ("session_hash");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "membership_notify" CHECK ("memberships"."notify" IN ('all','mine','off'));