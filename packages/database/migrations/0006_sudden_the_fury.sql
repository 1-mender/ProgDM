ALTER TABLE `knowledge_entries` RENAME TO `__old_knowledge_entries_for_migration`;--> statement-breakpoint
CREATE TABLE `__new_knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`visibility` text DEFAULT 'hidden' NOT NULL,
	`visible_to_character_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visible_to_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "knowledge_category_valid" CHECK("__new_knowledge_entries"."category" in ('npc', 'monster', 'note', 'quest')),
	CONSTRAINT "knowledge_visibility_valid" CHECK("__new_knowledge_entries"."visibility" in ('hidden', 'character', 'party')),
	CONSTRAINT "knowledge_visibility_target_valid" CHECK(("__new_knowledge_entries"."visibility" = 'character' and "__new_knowledge_entries"."visible_to_character_id" is not null) or ("__new_knowledge_entries"."visibility" != 'character' and "__new_knowledge_entries"."visible_to_character_id" is null)),
	CONSTRAINT "knowledge_title_valid" CHECK(length(trim("__new_knowledge_entries"."title")) between 1 and 120),
	CONSTRAINT "knowledge_description_valid" CHECK(length("__new_knowledge_entries"."description") <= 2000)
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_entries` (`id`, `campaign_id`, `category`, `title`, `description`, `visibility`, `visible_to_character_id`, `created_at`)
SELECT k.`id`, k.`campaign_id`, k.`category`, k.`title`, k.`description`,
	CASE WHEN k.`visibility` = 'player' AND EXISTS (
		SELECT 1 FROM `session_character_assignments` a
		INNER JOIN `players` p ON p.`id` = a.`player_id`
		INNER JOIN `sessions` s ON s.`id` = a.`session_id`
		INNER JOIN `characters` c ON c.`id` = a.`character_id`
		WHERE p.`id` = k.`visible_to_player_id` AND s.`campaign_id` = k.`campaign_id` AND c.`campaign_id` = k.`campaign_id`
	) THEN 'character'
	WHEN k.`visibility` = 'player' THEN 'hidden'
	ELSE k.`visibility` END,
	(SELECT a.`character_id` FROM `session_character_assignments` a
		INNER JOIN `players` p ON p.`id` = a.`player_id`
		INNER JOIN `sessions` s ON s.`id` = a.`session_id`
		INNER JOIN `characters` c ON c.`id` = a.`character_id`
		WHERE k.`visibility` = 'player' AND p.`id` = k.`visible_to_player_id`
			AND s.`campaign_id` = k.`campaign_id` AND c.`campaign_id` = k.`campaign_id`),
	k.`created_at`
FROM `__old_knowledge_entries_for_migration` k;--> statement-breakpoint
ALTER TABLE `__new_knowledge_entries` RENAME TO `knowledge_entries`;--> statement-breakpoint
CREATE TABLE `knowledge_migration_issues` (
	`knowledge_entry_id` text NOT NULL,
	`legacy_player_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`knowledge_entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_migration_issue_reason_valid" CHECK(`reason` in ('missing_assignment', 'campaign_mismatch'))
);--> statement-breakpoint
INSERT INTO `knowledge_migration_issues` (`knowledge_entry_id`, `legacy_player_id`, `reason`, `created_at`)
SELECT k.`id`, k.`visible_to_player_id`,
	CASE WHEN EXISTS (
		SELECT 1 FROM `session_character_assignments` a WHERE a.`player_id` = k.`visible_to_player_id`
	) THEN 'campaign_mismatch' ELSE 'missing_assignment' END,
	k.`created_at`
FROM `__old_knowledge_entries_for_migration` k
WHERE k.`visibility` = 'player' AND NOT EXISTS (
	SELECT 1 FROM `session_character_assignments` a
	INNER JOIN `players` p ON p.`id` = a.`player_id`
	INNER JOIN `sessions` s ON s.`id` = a.`session_id`
	INNER JOIN `characters` c ON c.`id` = a.`character_id`
	WHERE p.`id` = k.`visible_to_player_id` AND s.`campaign_id` = k.`campaign_id` AND c.`campaign_id` = k.`campaign_id`
);
--> statement-breakpoint
DROP TABLE `__old_knowledge_entries_for_migration`;--> statement-breakpoint
CREATE INDEX `knowledge_entries_campaign_id_idx` ON `knowledge_entries` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `knowledge_entries_visible_character_idx` ON `knowledge_entries` (`visible_to_character_id`);
