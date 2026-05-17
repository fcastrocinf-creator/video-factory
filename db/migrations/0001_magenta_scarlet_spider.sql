ALTER TABLE `runs` ADD `current_step` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `progress` integer DEFAULT 0 NOT NULL;