CREATE TABLE "human_avatars" (
	"human_id" text PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "human_avatar_mime" CHECK ("human_avatars"."mime" IN ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "human_avatar_size" CHECK (length("human_avatars"."bytes") BETWEEN 1 AND 131072)
);
--> statement-breakpoint
ALTER TABLE "humans" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "human_avatars" ADD CONSTRAINT "human_avatars_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "humans" ADD CONSTRAINT "human_name_length" CHECK ("humans"."name" IS NULL OR length("humans"."name") BETWEEN 1 AND 80);