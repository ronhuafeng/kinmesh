CREATE TABLE `agent_avatars` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` blob NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`,`team_id`) REFERENCES `agents`(`id`,`team_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_avatar_mime" CHECK("agent_avatars"."mime" IN ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "agent_avatar_size" CHECK(length("agent_avatars"."bytes") BETWEEN 1 AND 131072)
);
