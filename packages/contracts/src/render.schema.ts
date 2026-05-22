import { z } from 'zod';
import { ParsedScriptSchema } from './script.schema.js';
import { AudioTrackSchema } from './audio.schema.js';
import { SubtitleTrackSchema } from './subtitle.schema.js';
import { VideoTrackSchema } from './video.schema.js';
import { SceneTrackSchema } from './scene.schema.js';

export const RenderJobSchema = z.object({
  runId: z.string().uuid(),
  brandId: z.string(),
  presetId: z.string(),

  parsedScript: ParsedScriptSchema,
  audioTrack: AudioTrackSchema,
  subtitleTrack: SubtitleTrackSchema,
  // Imagen estática (Imagen 4). Siempre presente — sirve de keyframe para Veo
  // y de fallback si videoTrack es null.
  imagePath: z.string(),
  // Track de video animado (clips de Veo). Si está, el compositor usa PlanoAnimado;
  // si está vacío/undefined, usa PlanoFijo con la imagen estática + Ken Burns.
  videoTrack: VideoTrackSchema.optional(),
  // Track de escenas (multi-escena con imágenes diferentes). Si está, el compositor
  // usa PlanoEscenas. Prioridad sobre videoTrack (si ambos presentes, gana escenas).
  sceneTrack: SceneTrackSchema.optional(),

  // Hint para el compositor: cuando true, cada escena se renderiza con motion
  // FUERTE (Ken Burns agresivo + zoom dinámico) para dar sensación animada sin
  // necesitar Veo por escena. Se setea cuando el preset.format es b-roll-animated
  // o voiceover-animated.
  animatedScenes: z.boolean().default(false),

  outputPath: z.string(),
  resolution: z.tuple([z.literal(1080), z.literal(1920)]),
  fps: z.literal(30),

  status: z.enum(['pending', 'rendering', 'completed', 'failed']),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional(),
});

export type RenderJob = z.infer<typeof RenderJobSchema>;
