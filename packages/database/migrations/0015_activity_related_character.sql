PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_campaign_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`session_id` text,
	`player_id` text,
	`character_id` text,
	`related_character_id` text,
	`catalog_item_id` text,
	`knowledge_entry_id` text,
	`operation_id` text,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`knowledge_entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`related_character_id`,`campaign_id`) REFERENCES `characters`(`id`,`campaign_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "campaign_activity_payload_valid" CHECK(json_valid("__new_campaign_activity"."payload"))
);
--> statement-breakpoint
INSERT INTO `__new_campaign_activity`("id", "campaign_id", "session_id", "player_id", "character_id", "related_character_id", "catalog_item_id", "knowledge_entry_id", "operation_id", "type", "created_at", "payload") SELECT "id", "campaign_id", "session_id", "player_id", "character_id", NULL, "catalog_item_id", "knowledge_entry_id", "operation_id", "type", "created_at", "payload" FROM `campaign_activity`;--> statement-breakpoint
DROP TABLE `campaign_activity`;--> statement-breakpoint
ALTER TABLE `__new_campaign_activity` RENAME TO `campaign_activity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `campaign_activity_campaign_order_idx` ON `campaign_activity` (`campaign_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `campaign_activity_session_order_idx` ON `campaign_activity` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `campaign_activity_related_character_idx` ON `campaign_activity` (`related_character_id`,`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_activity_operation_unique` ON `campaign_activity` (`operation_id`) WHERE "campaign_activity"."operation_id" is not null;
