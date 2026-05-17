import { z } from 'zod';

// Estructura mínima para Estrategia B (multi-escena). En MVP plano fijo (Estrategia A)
// el video tiene una sola "escena" implícita, por lo que este schema no se usa todavía.
export const SceneSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().nonnegative(),
  imagePath: z.string().optional(),
  videoPath: z.string().optional(),
  prompt: z.string().optional(),
});

export type Scene = z.infer<typeof SceneSchema>;
