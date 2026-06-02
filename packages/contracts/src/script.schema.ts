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

// Multi-voz ("Estilo CapCut"): un ad puede tener VARIOS hablantes (ej. una figura
// de autoridad que explica + una usuaria que prueba el producto). SpeakerProfile
// generaliza NarratorProfile con un id, un rol y la voz asignada. Retro-compatible:
// si no hay speakers[], el flujo de una sola voz (narratorProfile) sigue igual.
export const SpeakerProfileSchema = z.object({
  // Identificador estable del hablante en el ad ('S1', 'S2', ...).
  id: z.string(),
  // Rol en el formato: autoridad/experto, usuaria que prueba, voz en off, otro.
  role: z.enum(['authority', 'user', 'voiceover', 'other']).default('other'),
  gender: z.enum(['male', 'female', 'neutral']).default('neutral'),
  ageRange: z.string().default('30-50'),
  // Descripción visual (para continuity si el hablante aparece en pantalla).
  characterCard: z.string().default(''),
  // Voz asignada (id de brand.voiceLibrary). La elige el director de reparto de voz.
  voiceId: z.string().optional(),
});

export type SpeakerProfile = z.infer<typeof SpeakerProfileSchema>;

export const ParsedScriptSchema = z.object({
  language: z.string(),
  segments: z.array(ScriptSegmentSchema),
  estimatedDurationSeconds: z.number(),
  narratorProfile: NarratorProfileSchema.optional(),
  // Multi-voz: lista de hablantes detectados (opcional, retro-compat).
  speakers: z.array(SpeakerProfileSchema).optional(),
});

export type ParsedScript = z.infer<typeof ParsedScriptSchema>;
