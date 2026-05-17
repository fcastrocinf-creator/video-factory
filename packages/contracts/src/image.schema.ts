import { z } from 'zod';

export const ImageAssetMetadataSchema = z.object({
  model: z.string(),
  engine: z.string(),
  seed: z.number().int().optional(),
  safetyFilterLevel: z.string().optional(),
  personGeneration: z.string().optional(),
});

export type ImageAssetMetadata = z.infer<typeof ImageAssetMetadataSchema>;

export const ImageAssetSchema = z.object({
  filePath: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.literal('png'),
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  metadata: ImageAssetMetadataSchema.optional(),
});

export type ImageAsset = z.infer<typeof ImageAssetSchema>;
