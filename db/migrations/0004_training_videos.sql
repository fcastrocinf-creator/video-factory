CREATE TABLE `training_videos` (
  `id` text PRIMARY KEY NOT NULL,
  `video_path` text NOT NULL,
  `video_file_name` text NOT NULL,
  `video_bytes` integer NOT NULL,
  `status` text DEFAULT 'uploaded' NOT NULL,
  `analysis_json` text,
  `trajectory_json` text,
  `result_preset_id` text,
  `general_ideas_json` text,
  `current_step` text,
  `progress` integer DEFAULT 0 NOT NULL,
  `error_message` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `trained_at` integer
);
