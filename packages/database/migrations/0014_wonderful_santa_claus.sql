ALTER TABLE `characters` ADD `inventory_capacity` integer NOT NULL DEFAULT 12
	CHECK(typeof(`inventory_capacity`) = 'integer' and `inventory_capacity` >= 0);--> statement-breakpoint
ALTER TABLE `catalog_items` ADD `description` text NOT NULL DEFAULT ''
	CHECK(length(`description`) <= 2000);--> statement-breakpoint
ALTER TABLE `catalog_items` ADD `category` text NOT NULL DEFAULT 'special'
	CHECK(`category` in ('key', 'document', 'tool', 'consumable', 'equipment', 'artifact', 'special'));--> statement-breakpoint
ALTER TABLE `catalog_items` ADD `rarity` text
	CHECK(`rarity` is null or `rarity` in ('common', 'uncommon', 'rare', 'unique'));--> statement-breakpoint
ALTER TABLE `catalog_items` ADD `equipment_slot` text
	CHECK(`equipment_slot` is null or `equipment_slot` in ('primary', 'secondary', 'armor', 'accessory', 'tool', 'special'));--> statement-breakpoint
ALTER TABLE `catalog_items` ADD `transfer_allowed` integer NOT NULL DEFAULT 1
	CHECK(typeof(`transfer_allowed`) = 'integer' and `transfer_allowed` in (0, 1));--> statement-breakpoint
ALTER TABLE `catalog_items` ADD `discard_allowed` integer NOT NULL DEFAULT 1
	CHECK(typeof(`discard_allowed`) = 'integer' and `discard_allowed` in (0, 1));--> statement-breakpoint
ALTER TABLE `inventory_items` ADD `equipped_slot` text
	CHECK(`equipped_slot` is null or (`equipped_slot` in ('primary', 'secondary', 'armor', 'accessory', 'tool', 'special') and `catalog_item_id` is not null and `quantity` = 1));--> statement-breakpoint
UPDATE `characters`
SET `inventory_capacity` = max(12, (
	SELECT count(*) FROM `inventory_items`
	WHERE `inventory_items`.`character_id` = `characters`.`id` AND `inventory_items`.`equipped_slot` IS NULL
));--> statement-breakpoint
DROP INDEX `inventory_items_character_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_equipped_slot_unique` ON `inventory_items` (`character_id`, `equipped_slot`)
	WHERE `equipped_slot` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_character_catalog_bag_unique` ON `inventory_items` (`character_id`, `catalog_item_id`)
	WHERE `catalog_item_id` IS NOT NULL AND `equipped_slot` IS NULL;
