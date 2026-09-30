CREATE TABLE `character_personal_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "character_personal_note_body_valid" CHECK(length(trim("character_personal_notes"."body")) between 1 and 2000)
);
--> statement-breakpoint
CREATE INDEX `character_personal_notes_character_idx` ON `character_personal_notes` (`character_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `character_read_state` (
	`character_id` text PRIMARY KEY NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_seen_id` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`archived_at` text,
	`short_description` text DEFAULT '' NOT NULL,
	`archetype` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`personal_goal` text DEFAULT '' NOT NULL,
	`dm_notes` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "character_name_valid" CHECK(length(trim("__new_characters"."name")) between 1 and 120),
	CONSTRAINT "character_profile_valid" CHECK(length("__new_characters"."short_description") <= 500 and length("__new_characters"."archetype") <= 120 and length("__new_characters"."origin") <= 500 and length("__new_characters"."personal_goal") <= 500 and length("__new_characters"."dm_notes") <= 2000)
);
--> statement-breakpoint
INSERT INTO `__new_characters`("id", "campaign_id", "name", "created_at", "archived_at", "short_description", "archetype", "origin", "personal_goal", "dm_notes") SELECT "id", "campaign_id", "name", "created_at", "archived_at", '', '', '', '', '' FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
ALTER TABLE `__new_characters` RENAME TO `characters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `characters_campaign_id_idx` ON `characters` (`campaign_id`);
