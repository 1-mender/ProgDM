CREATE TABLE `session_character_assignments` (
	`player_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`character_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_character_assignments_session_character_unique` ON `session_character_assignments` (`session_id`,`character_id`);--> statement-breakpoint
CREATE INDEX `session_character_assignments_character_idx` ON `session_character_assignments` (`character_id`);--> statement-breakpoint
INSERT INTO `session_character_assignments` (`player_id`, `session_id`, `character_id`, `created_at`)
SELECT `players`.`id`, `players`.`session_id`, `characters`.`id`, `characters`.`created_at`
FROM `characters` INNER JOIN `players` ON `players`.`id` = `characters`.`player_id`;--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "character_name_valid" CHECK(length(trim("__new_characters"."name")) between 1 and 120)
);--> statement-breakpoint
INSERT INTO `__new_characters`("id", "campaign_id", "name", "created_at") SELECT "id", "campaign_id", "name", "created_at" FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
ALTER TABLE `__new_characters` RENAME TO `characters`;--> statement-breakpoint
CREATE INDEX `characters_campaign_id_idx` ON `characters` (`campaign_id`);
