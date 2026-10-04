CREATE TABLE `campaign_profile_field_definitions` (
	`id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`label` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`id`, `campaign_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "campaign_profile_field_label_valid" CHECK(length(trim("campaign_profile_field_definitions"."label")) between 1 and 60),
	CONSTRAINT "campaign_profile_field_position_valid" CHECK("campaign_profile_field_definitions"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_profile_field_position_unique` ON `campaign_profile_field_definitions` (`campaign_id`,`position`);--> statement-breakpoint
CREATE INDEX `campaign_profile_fields_campaign_order_idx` ON `campaign_profile_field_definitions` (`campaign_id`,`position`,`id`);--> statement-breakpoint
CREATE TABLE `character_profile_field_values` (
	`campaign_id` text NOT NULL,
	`field_id` text NOT NULL,
	`character_id` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`field_id`, `character_id`),
	FOREIGN KEY (`field_id`,`campaign_id`) REFERENCES `campaign_profile_field_definitions`(`id`,`campaign_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`,`campaign_id`) REFERENCES `characters`(`id`,`campaign_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "character_profile_field_value_valid" CHECK(length("character_profile_field_values"."value") <= 500)
);
--> statement-breakpoint
CREATE INDEX `character_profile_field_values_character_idx` ON `character_profile_field_values` (`character_id`,`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `characters_id_campaign_unique` ON `characters` (`id`,`campaign_id`);