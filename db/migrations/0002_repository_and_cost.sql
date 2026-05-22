ALTER TABLE `runs` ADD `product_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `estimated_cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `image_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `tts_chars_billed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `original_run_id` text;
