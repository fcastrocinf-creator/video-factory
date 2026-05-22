import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  brandId: text('brand_id').notNull(),
  presetId: text('preset_id').notNull(),
  // Producto opcional al que pertenece este video (id dentro de brand.products).
  // Permite agrupar el repositorio de videos por marca + producto.
  productId: text('product_id'),

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

  // Tracking de costo / uso.
  estimatedCostUsd: real('estimated_cost_usd').notNull().default(0),
  imageCount: integer('image_count').notNull().default(0),
  ttsCharsBilled: integer('tts_chars_billed').notNull().default(0),

  // Soft delete con papelera de 30 días. NULL = visible; integer = mandado a
  // papelera en ese timestamp. Un cron / verificación periódica purga registros
  // con deletedAt < ahora - 30 días.
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),

  // Si este run fue creado vía corrección de otro, originalRunId apunta al run
  // padre. Útil para visualizar linaje de iteraciones en el repositorio.
  originalRunId: text('original_run_id'),

  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

/**
 * Tabla `rips` — guarda los anuncios de referencia que el usuario sube para
 * analizar y ripear. Cada rip puede dar origen a múltiples runs.
 */
export const rips = sqliteTable('rips', {
  id: text('id').primaryKey(),
  videoPath: text('video_path').notNull(),
  videoFileName: text('video_file_name').notNull(),
  videoBytes: integer('video_bytes').notNull(),
  status: text('status', {
    enum: ['uploaded', 'analyzing', 'analyzed', 'failed'],
  })
    .notNull()
    .default('uploaded'),
  // JSON serializado de AdAnalysis (de @video-factory/contracts).
  analysisJson: text('analysis_json'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  analyzedAt: integer('analyzed_at', { mode: 'timestamp' }),
});

export type Rip = typeof rips.$inferSelect;
export type NewRip = typeof rips.$inferInsert;

/**
 * Tabla `training_videos` — repositorio de videos que el usuario quiere usar
 * como REFERENCIA DE ESTILO. A diferencia de `rips`, no se genera un video
 * directamente: la IA itera generando frames y comparando contra el original
 * hasta lograr alta fidelidad visual, y produce un PRESET destilado que después
 * se aprueba en /admin para ser usado desde /create.
 *
 * Estados:
 *   uploaded    → recién subido, esperando que el usuario aprete "Aprender formato"
 *   analyzing   → Gemini multimodal extrayendo escenas, narrador, paleta, etc.
 *   training    → loop iterativo de generar/comparar/regen ejecutándose
 *   completed   → preset destilado persistido en pending/ + "ideas generales" listas
 *   failed      → algún step falló de forma terminal
 */
export const trainingVideos = sqliteTable('training_videos', {
  id: text('id').primaryKey(),
  videoPath: text('video_path').notNull(),
  videoFileName: text('video_file_name').notNull(),
  videoBytes: integer('video_bytes').notNull(),
  status: text('status', {
    enum: ['uploaded', 'analyzing', 'training', 'completed', 'failed'],
  })
    .notNull()
    .default('uploaded'),

  // JSON serializado de AdAnalysis (Gemini multimodal) — disponible después de analyzing.
  analysisJson: text('analysis_json'),

  // JSON serializado de la trayectoria: keyframes extraídos + iteraciones por frame
  // con scores e imagenes paths. Ver style-trainer.ts → TrainingTrajectorySchema.
  trajectoryJson: text('trajectory_json'),

  // Si la training convergió y se construyó un preset destilado, su id va acá.
  // El preset.json queda en packages/presets/pending/learned-trained-*.preset.json
  // hasta que el admin lo apruebe en /admin.
  resultPresetId: text('result_preset_id'),

  // "Ideas generales" extraídas del original: 3-5 bullets sobre línea editorial,
  // hook, paleta, ritmo. Renderizadas en la UI al completar.
  generalIdeasJson: text('general_ideas_json'),

  // Step actual + porcentaje para feedback en la UI durante el training.
  currentStep: text('current_step'),
  progress: integer('progress').notNull().default(0),

  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  trainedAt: integer('trained_at', { mode: 'timestamp' }),
});

export type TrainingVideo = typeof trainingVideos.$inferSelect;
export type NewTrainingVideo = typeof trainingVideos.$inferInsert;
