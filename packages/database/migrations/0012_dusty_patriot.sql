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
	CONSTRAINT "knowledge_category_valid" CHECK("__new_knowledge_entries"."category" in ('character', 'place', 'creature', 'item', 'event', 'fact')),
	CONSTRAINT "knowledge_visibility_valid" CHECK("__new_knowledge_entries"."visibility" in ('hidden', 'character', 'party')),
	CONSTRAINT "knowledge_visibility_target_valid" CHECK(("__new_knowledge_entries"."visibility" = 'character' and "__new_knowledge_entries"."visible_to_character_id" is not null) or ("__new_knowledge_entries"."visibility" != 'character' and "__new_knowledge_entries"."visible_to_character_id" is null)),
	CONSTRAINT "knowledge_title_valid" CHECK(length(trim("__new_knowledge_entries"."title")) between 1 and 120),
	CONSTRAINT "knowledge_description_valid" CHECK(length("__new_knowledge_entries"."description") <= 2000)
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_entries`("id", "campaign_id", "category", "title", "description", "visibility", "visible_to_character_id", "created_at")
SELECT "id", "campaign_id",
  CASE "category"
    WHEN 'npc' THEN 'character'
    WHEN 'monster' THEN 'creature'
    WHEN 'note' THEN 'fact'
    WHEN 'quest' THEN 'event'
    ELSE "category"
  END,
  "title", "description", "visibility", "visible_to_character_id", "created_at"
FROM `knowledge_entries`;--> statement-breakpoint
DROP TABLE `knowledge_entries`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_entries` RENAME TO `knowledge_entries`;--> statement-breakpoint
CREATE INDEX `knowledge_entries_campaign_id_idx` ON `knowledge_entries` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `knowledge_entries_visible_character_idx` ON `knowledge_entries` (`visible_to_character_id`);
