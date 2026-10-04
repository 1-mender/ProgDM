ALTER TABLE `characters` ADD COLUMN `traits` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `appearance` text DEFAULT '' NOT NULL CHECK(length(`appearance`) <= 1000);
--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `quote` text DEFAULT '' NOT NULL CHECK(length(`quote`) <= 300);
