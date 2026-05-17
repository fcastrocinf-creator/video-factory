import { z } from 'zod';
import { ParsedScriptSchema } from './script.schema.js';
import { AudioTrackSchema } from './audio.schema.js';
import { SubtitleTrackSchema } from './subtitle.schema.js';

export const RenderJobSchema = z.object({
  runId: z.string().uuid(),
  brandId: z.string(),
  presetId: z.string(),

  parsedScript: ParsedScriptSchema,
  audioTrack: AudioTrackSchema,
  subtitleTrack: SubtitleTrackSchema,
  imagePath: z.string(),

  outputPath: z.string(),
  resolution: z.tuple([z.literal(1080), z.literal(1920)]),
  fps: z.literal(30),

  status: z.enum(['pending', 'rendering', 'completed', 'failed']),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional(),
});

export type RenderJob = z.infer<typeof RenderJobSchema>;
