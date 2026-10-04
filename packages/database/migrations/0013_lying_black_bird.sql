CREATE TABLE `knowledge_fact_reveals` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`knowledge_fact_id` text NOT NULL,
	`audience` text NOT NULL,
	`character_id` text,
	`session_id` text,
	`operation_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_fact_id`,`campaign_id`) REFERENCES `knowledge_facts`(`id`,`campaign_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`,`campaign_id`) REFERENCES `characters`(`id`,`campaign_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`,`campaign_id`) REFERENCES `sessions`(`id`,`campaign_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "knowledge_fact_reveal_audience_valid" CHECK("knowledge_fact_reveals"."audience" in ('party', 'character')),
	CONSTRAINT "knowledge_fact_reveal_target_valid" CHECK(("knowledge_fact_reveals"."audience" = 'party' and "knowledge_fact_reveals"."character_id" is null) or ("knowledge_fact_reveals"."audience" = 'character' and "knowledge_fact_reveals"."character_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_fact_reveals_id_campaign_unique` ON `knowledge_fact_reveals` (`id`,`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_fact_reveals_party_unique` ON `knowledge_fact_reveals` (`knowledge_fact_id`) WHERE "knowledge_fact_reveals"."audience" = 'party';--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_fact_reveals_character_unique` ON `knowledge_fact_reveals` (`knowledge_fact_id`,`character_id`) WHERE "knowledge_fact_reveals"."audience" = 'character';--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_fact_reveals_operation_unique` ON `knowledge_fact_reveals` (`operation_id`) WHERE "knowledge_fact_reveals"."operation_id" is not null;--> statement-breakpoint
CREATE INDEX `knowledge_fact_reveals_campaign_fact_idx` ON `knowledge_fact_reveals` (`campaign_id`,`knowledge_fact_id`);--> statement-breakpoint
CREATE INDEX `knowledge_fact_reveals_character_campaign_idx` ON `knowledge_fact_reveals` (`character_id`,`campaign_id`);--> statement-breakpoint
CREATE INDEX `knowledge_fact_reveals_session_campaign_idx` ON `knowledge_fact_reveals` (`session_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `knowledge_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`knowledge_entry_id` text NOT NULL,
	`body` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_entry_id`,`campaign_id`) REFERENCES `knowledge_entries`(`id`,`campaign_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_fact_body_valid" CHECK(length(trim("knowledge_facts"."body")) between 1 and 2000),
	CONSTRAINT "knowledge_fact_position_valid" CHECK("knowledge_facts"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_facts_id_campaign_unique` ON `knowledge_facts` (`id`,`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_facts_entry_position_unique` ON `knowledge_facts` (`knowledge_entry_id`,`position`);--> statement-breakpoint
CREATE INDEX `knowledge_facts_entry_order_idx` ON `knowledge_facts` (`knowledge_entry_id`,`position`,`id`);--> statement-breakpoint
ALTER TABLE `campaign_activity` ADD `operation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_activity_operation_unique` ON `campaign_activity` (`operation_id`) WHERE "campaign_activity"."operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_entries_id_campaign_unique` ON `knowledge_entries` (`id`,`campaign_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_id_campaign_unique` ON `sessions` (`id`,`campaign_id`);