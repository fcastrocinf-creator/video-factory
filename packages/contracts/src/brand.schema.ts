import { z } from 'zod';

export const ElevenLabsVoiceConfigSchema = z.object({
  voiceId: z.string(),
  modelId: z.string().default('eleven_multilingual_v2'),
  stability: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speakerBoost: z.boolean().default(true),
  speedMultiplier: z.number().default(1.0),
});

export type ElevenLabsVoiceConfig = z.infer<typeof ElevenLabsVoiceConfigSchema>;

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

export type Product = z.infer<typeof ProductSchema>;

export const BrandConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),

  products: z.array(ProductSchema),

  defaultVoice: ElevenLabsVoiceConfigSchema,

  language: z.string(),

  brandColors: z.array(z.string()).default([]),

  toneRules: z
    .object({
      avoid: z.array(z.string()).default([]),
      prefer: z.array(z.string()).default([]),
    })
    .default({ avoid: [], prefer: [] }),

  logoPath: z.string().optional(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BrandConfig = z.infer<typeof BrandConfigSchema>;
