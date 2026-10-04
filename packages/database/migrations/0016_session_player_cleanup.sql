DROP INDEX `players_session_name_unique`;--> statement-breakpoint
DROP INDEX `players_session_status_idx`;--> statement-breakpoint
ALTER TABLE `players` ADD `removed_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `players_session_name_unique` ON `players` (`session_id`,lower(trim("display_name"))) WHERE "players"."removed_at" is null;--> statement-breakpoint
CREATE INDEX `players_session_status_idx` ON `players` (`session_id`,`removed_at`,`status`);--> statement-breakpoint
DROP INDEX `session_character_assignments_session_character_unique`;--> statement-breakpoint
DROP INDEX `session_character_assignments_character_idx`;--> statement-breakpoint
ALTER TABLE `session_character_assignments` ADD `released_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `session_character_assignments_session_character_unique` ON `session_character_assignments` (`session_id`,`character_id`) WHERE "session_character_assignments"."released_at" is null;--> statement-breakpoint
CREATE INDEX `session_character_assignments_character_idx` ON `session_character_assignments` (`character_id`,`released_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`join_token` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "session_status_valid" CHECK("__new_sessions"."status" in ('planned', 'active', 'ended')),
	CONSTRAINT "session_not_active_when_removed" CHECK("__new_sessions"."removed_at" is null or "__new_sessions"."status" != 'active'),
	CONSTRAINT "session_name_valid" CHECK(length(trim("__new_sessions"."name")) between 1 and 120)
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "campaign_id", "name", "status", "join_token", "created_at", "removed_at") SELECT "id", "campaign_id", "name", "status", "join_token", "created_at", NULL FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sessions_campaign_id_idx` ON `sessions` (`campaign_id`,`removed_at`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_id_campaign_unique` ON `sessions` (`id`,`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_join_token_unique` ON `sessions` (`join_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_active` ON `sessions` (`status`) WHERE "sessions"."status" = 'active';
