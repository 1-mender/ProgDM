CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`visibility` text DEFAULT 'hidden' NOT NULL,
	`visible_to_player_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visible_to_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "knowledge_category_valid" CHECK("knowledge_entries"."category" in ('npc', 'monster', 'note', 'quest')),
	CONSTRAINT "knowledge_visibility_valid" CHECK("knowledge_entries"."visibility" in ('hidden', 'player', 'party')),
	CONSTRAINT "knowledge_visibility_target_valid" CHECK(("knowledge_entries"."visibility" = 'player' and "knowledge_entries"."visible_to_player_id" is not null) or ("knowledge_entries"."visibility" != 'player' and "knowledge_entries"."visible_to_player_id" is null)),
	CONSTRAINT "knowledge_title_valid" CHECK(length(trim("knowledge_entries"."title")) between 1 and 120),
	CONSTRAINT "knowledge_description_valid" CHECK(length("knowledge_entries"."description") <= 2000)
);
--> statement-breakpoint
CREATE INDEX `knowledge_entries_campaign_id_idx` ON `knowledge_entries` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `knowledge_entries_visible_player_idx` ON `knowledge_entries` (`visible_to_player_id`);