import { z } from 'zod';

export const VideoClipSchema = z.object({
  filePath: z.string(),
  durationSeconds: z.number().positive(),
  prompt: z.string(),
  // El timestamp dentro del video final donde empieza este clip. Sirve para
  // regenerar uno solo en el futuro ("cambiame el segundo 0:35 al 0:37").
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().nonnegative(),
});

export type VideoClip = z.infer<typeof VideoClipSchema>;

export const VideoTrackSchema = z.object({
  // Cuando estrategia=plano_fijo_animado tenemos UN clip que se loopea/extiende.
  // Cuando estrategia=multi_escena tenemos N clips concatenados.
  clips: z.array(VideoClipSchema).min(1),
  totalDurationSeconds: z.number().positive(),
  fps: z.number().int().positive().default(30),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.literal('mp4'),
  // Engine que generó los clips (audita procedencia y permite regenerar).
  engine: z.enum(['veo-lite', 'veo-fast', 'veo-standard']),
  // Para regeneración: imagen de referencia + prompts usados.
  referenceImagePath: z.string().optional(),
});

export type VideoTrack = z.infer<typeof VideoTrackSchema>;
