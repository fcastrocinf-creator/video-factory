// editor-actions.ts — Acciones ejecutables que el Editor IA puede pedir al pipeline.
//
// El editor IA NO es solo un opinador — emite acciones estructuradas que el
// pipeline EJECUTA automáticamente y vuelve a someter el video al editor.
// Loop iterativo hasta `approve` o max iteraciones.
//
// Fase 1 (25-may-2026):
//   - extend-duration: stretch scene.endTimeSeconds para cubrir audio
//   - approve: el video está OK, marcar completed
//   - manual-fix: el editor no puede arreglar solo, escalar al owner
//
// Fase 2 (TODO):
//   - regenerate-scene: re-generar imagen + animation de una scene
//   - swap-image: usar otra imagen ya generada para una scene
//   - adjust-prompt: cambiar prompt y regenerar

import { z } from 'zod';

export const ActionExtendDurationSchema = z.object({
  type: z.literal('extend-duration'),
  sceneIndex: z.number().int().min(0),
  newEndTimeSeconds: z.number().positive(),
  reason: z.string().min(5).max(300),
});
export type ActionExtendDuration = z.infer<typeof ActionExtendDurationSchema>;

export const ActionTrimDurationSchema = z.object({
  type: z.literal('trim-duration'),
  sceneIndex: z.number().int().min(0),
  newEndTimeSeconds: z.number().positive(),
  reason: z.string().min(5).max(300),
});
export type ActionTrimDuration = z.infer<typeof ActionTrimDurationSchema>;

export const ActionRegenerateSceneSchema = z.object({
  type: z.literal('regenerate-scene'),
  sceneIndex: z.number().int().min(0),
  // Si se pasa, regenera con NUEVO prompt. Sino, regenera con el mismo prompt
  // (cambio de seed implícito por re-call del provider).
  newImagePrompt: z.string().min(20).max(2000).optional(),
  // Si la scene era animada, ¿re-animar también? Default true.
  reAnimate: z.boolean().default(true),
  reason: z.string().min(5).max(400),
});
export type ActionRegenerateScene = z.infer<typeof ActionRegenerateSceneSchema>;

export const ActionAdjustPromptSchema = z.object({
  type: z.literal('adjust-prompt'),
  sceneIndex: z.number().int().min(0),
  newImagePrompt: z.string().min(20).max(2000),
  reason: z.string().min(5).max(300),
});
export type ActionAdjustPrompt = z.infer<typeof ActionAdjustPromptSchema>;

export const ActionApproveSchema = z.object({
  type: z.literal('approve'),
  reason: z.string().min(5).max(300),
});
export type ActionApprove = z.infer<typeof ActionApproveSchema>;

export const ActionManualFixSchema = z.object({
  type: z.literal('manual-fix'),
  reason: z.string().min(5).max(500),
  humanSteps: z.array(z.string().min(5).max(300)),
});
export type ActionManualFix = z.infer<typeof ActionManualFixSchema>;

export const EditorActionSchema = z.discriminatedUnion('type', [
  ActionExtendDurationSchema,
  ActionTrimDurationSchema,
  ActionRegenerateSceneSchema,
  ActionAdjustPromptSchema,
  ActionApproveSchema,
  ActionManualFixSchema,
]);
export type EditorAction = z.infer<typeof EditorActionSchema>;

/**
 * Output del editor IA v2 — devuelve acciones EJECUTABLES, no solo texto.
 */
export const EditorVerdictV2Schema = z.object({
  // Veredicto en lenguaje natural (igual que v1)
  verdict: z.string().min(20).max(1500),
  // Severidad general — informativa, NO bloqueante por sí sola (las acciones bloquean)
  severity: z.enum(['publishable', 'minor-polish', 'needs-rework', 'block-shipping']),
  // Lista de acciones a ejecutar EN ORDEN
  actions: z.array(EditorActionSchema).min(1),
});
export type EditorVerdictV2 = z.infer<typeof EditorVerdictV2Schema>;
