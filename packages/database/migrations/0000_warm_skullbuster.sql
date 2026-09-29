CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "campaign_name_valid" CHECK(length(trim("campaigns"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`join_token` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "session_status_valid" CHECK("sessions"."status" in ('planned', 'active', 'ended')),
	CONSTRAINT "session_name_valid" CHECK(length(trim("sessions"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE INDEX `sessions_campaign_id_idx` ON `sessions` (`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_join_token_unique` ON `sessions` (`join_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_active` ON `sessions` (`status`) WHERE "sessions"."status" = 'active';