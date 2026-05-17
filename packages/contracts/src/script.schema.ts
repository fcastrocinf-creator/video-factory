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

export const ParsedScriptSchema = z.object({
  language: z.string(),
  segments: z.array(ScriptSegmentSchema),
  estimatedDurationSeconds: z.number(),
});

export type ParsedScript = z.infer<typeof ParsedScriptSchema>;
