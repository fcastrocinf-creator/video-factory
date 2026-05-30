ALTER TABLE `runs` ADD `mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `paused_at_scene_index` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `awaiting_approval` integer DEFAULT false NOT NULL;