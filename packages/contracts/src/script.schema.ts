import { z } from 'zod';

export const ScriptInputSchema = z.object({
  rawText: z.string().min(10),
  language: z.string().default('es'),
});

export type ScriptInput = z.infer<typeof ScriptInputSchema>;

export const ScriptSegmentSchema = z.object({
  text: z.string(),
  pauseAfterMs: z.number().default(0),
  emphasisWords: z.array(z.string()).default([]),
});

export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

// Perfil del narrador inferido del guion. Lo usan: TTS (selección de voz),
// scene-planner (cómo dibujar al personaje cuando aparece) y scene-validator
// (verificar que el personaje en pantalla coincida con el género/edad).
export const NarratorProfileSchema = z.object({
  gender: z.enum(['male', 'female', 'neutral']).default('neutral'),
  ageRange: z.string().default('40-55'),
  // Descripción visual del narrador para character continuity. Ej:
  // "mature Asian man around 55, gray hair, ochre traditional robes, calm
  // demeanor, in a Kyoto temple setting".
  characterCard: z.string().default(''),
  // Si el guion no menciona narrador identificable (ej. solo voiceover
  // genérico anunciando producto), narratorPresent=false.
  narratorPresent: z.boolean().default(false),
}).default({
  gender: 'neutral',
  ageRange: '40-55',
  characterCard: '',
  narratorPresent: false,
});

export type NarratorProfile = z.infer<typeof NarratorProfileSchema>;

export const ParsedScriptSchema = z.object({
  language: z.string(),
  segments: z.array(ScriptSegmentSchema),
  estimatedDurationSeconds: z.number(),
  narratorProfile: NarratorProfileSchema.optional(),
});

export type ParsedScript = z.infer<typeof ParsedScriptSchema>;
