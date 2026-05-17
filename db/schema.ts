import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  brandId: text('brand_id').notNull(),
  presetId: text('preset_id').notNull(),

  scriptRaw: text('script_raw').notNull(),

  status: text('status', {
    enum: ['pending', 'running', 'completed', 'failed'],
  })
    .notNull()
    .default('pending'),

  workDir: text('work_dir'),
  outputPath: text('output_path'),
  durationSeconds: real('duration_seconds'),
  errorMessage: text('error_message'),

  currentStep: text('current_step'),
  progress: integer('progress').notNull().default(0),

  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
