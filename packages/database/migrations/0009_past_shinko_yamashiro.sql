ALTER TABLE `character_personal_notes` ADD COLUMN `title` text DEFAULT '' NOT NULL CHECK(length(`title`) <= 120);
--> statement-breakpoint
ALTER TABLE `character_personal_notes` ADD COLUMN `marker` text DEFAULT 'normal' NOT NULL CHECK(`marker` IN ('normal', 'important', 'check', 'question'));
--> statement-breakpoint
ALTER TABLE `character_personal_notes` ADD COLUMN `pinned` integer DEFAULT 0 NOT NULL CHECK(`pinned` IN (0, 1));
