CREATE TABLE `catalog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "catalog_item_name_valid" CHECK(length(trim("catalog_items"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_campaign_name_unique` ON `catalog_items` (`campaign_id`,lower(trim("name")));--> statement-breakpoint
CREATE INDEX `catalog_items_campaign_id_idx` ON `catalog_items` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `inventory_items` ADD `catalog_item_id` text REFERENCES catalog_items(id);