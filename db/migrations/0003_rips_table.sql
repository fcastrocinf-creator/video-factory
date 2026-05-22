CREATE TABLE `rips` (
  `id` text PRIMARY KEY NOT NULL,
  `video_path` text NOT NULL,
  `video_file_name` text NOT NULL,
  `video_bytes` integer NOT NULL,
  `status` text DEFAULT 'uploaded' NOT NULL,
  `analysis_json` text,
  `error_message` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `analyzed_at` integer
);
