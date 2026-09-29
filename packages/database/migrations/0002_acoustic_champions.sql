CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`name` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inventory_item_name_valid" CHECK(length(trim("inventory_items"."name")) between 1 and 120),
	CONSTRAINT "inventory_item_quantity_valid" CHECK("inventory_items"."quantity" between 1 and 9999)
);
--> statement-breakpoint
CREATE INDEX `inventory_items_character_id_idx` ON `inventory_items` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_character_name_unique` ON `inventory_items` (`character_id`,lower(trim("name")));