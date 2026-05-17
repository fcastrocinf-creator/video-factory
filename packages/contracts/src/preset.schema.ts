import { z } from 'zod';

export const PresetClassificationSchema = z.object({
  formato: z.enum(['ugc', 'educativo', 'storytelling', 'personaje_avatar']),
  hookAngulo: z.enum([
    'objeciones',
    'curiosidad',
    'autoridad',
    'testimonio',
    'test_diagnostico',
  ]),
  funnelStage: z.enum(['tofu', 'mofu', 'bofu']),
  awareness: z.enum(['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware']),
});

export type PresetClassification = z.infer<typeof PresetClassificationSchema>;

export const PresetVisualStyleSchema = z.object({
  promptTemplate: z.string(),
  negativePrompt: z.string(),
  aspectRatio: z.literal('9:16'),
  referenceImages: z.array(z.string()).default([]),
});

export type PresetVisualStyle = z.infer<typeof PresetVisualStyleSchema>;

export const PresetSubtitlesSchema = z.object({
  style: z.enum(['hook_banner', 'word_level_kinetic', 'minimal_elegant']),
  font: z.string().default('Inter'),
  fontSize: z.number().default(64),
  color: z.string().default('#FFFFFF'),
  strokeColor: z.string().default('#000000'),
  strokeWidth: z.number().default(4),
  highlightColor: z.string().default('#FFE600'),
  position: z.enum(['top', 'center', 'bottom']),
  allCaps: z.boolean().default(true),
});

export type PresetSubtitles = z.infer<typeof PresetSubtitlesSchema>;

export const PresetVoiceOverrideSchema = z.object({
  voiceId: z.string(),
  stability: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speakerBoost: z.boolean(),
});

export type PresetVoiceOverride = z.infer<typeof PresetVoiceOverrideSchema>;

export const PresetCompositionSchema = z.object({
  kenBurns: z.object({
    enabled: z.boolean().default(true),
    zoomStart: z.number().default(1.0),
    zoomEnd: z.number().default(1.15),
    panX: z.number().default(0),
    panY: z.number().default(0),
  }),
  backgroundMusic: z.object({
    enabled: z.boolean().default(false),
    volumeDb: z.number().default(-20),
  }),
});

export type PresetComposition = z.infer<typeof PresetCompositionSchema>;

export const PresetConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),

  classification: PresetClassificationSchema,

  estrategia: z.enum(['plano_fijo', 'multi_escena']),

  visualEngine: z.enum(['imagen4', 'veo-lite', 'veo-fast', 'veo-standard', 'higgsfield']),

  visualStyle: PresetVisualStyleSchema,

  subtitles: PresetSubtitlesSchema,

  voiceOverride: PresetVoiceOverrideSchema.optional(),

  defaultDurationSeconds: z.number(),
  scenesPerMinute: z.number(),

  composition: PresetCompositionSchema,

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PresetConfig = z.infer<typeof PresetConfigSchema>;
