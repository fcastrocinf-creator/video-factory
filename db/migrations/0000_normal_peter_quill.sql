CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`preset_id` text NOT NULL,
	`script_raw` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`work_dir` text,
	`output_path` text,
	`duration_seconds` real,
	`error_message` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
