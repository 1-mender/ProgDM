CREATE TABLE `campaign_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`session_id` text,
	`player_id` text,
	`character_id` text,
	`catalog_item_id` text,
	`knowledge_entry_id` text,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`knowledge_entry_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "campaign_activity_payload_valid" CHECK(json_valid("campaign_activity"."payload"))
);
--> statement-breakpoint
CREATE INDEX `campaign_activity_campaign_order_idx` ON `campaign_activity` (`campaign_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `campaign_activity_session_order_idx` ON `campaign_activity` (`session_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `characters` ADD `archived_at` text;