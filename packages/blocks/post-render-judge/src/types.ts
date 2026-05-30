// types.ts — schemas del post-render-judge.
//
// El "post-render judge" se ejecuta DESPUÉS del compositor, antes de marcar el
// run como completed. Valida que el video final no tenga problemas que el
// preview-judge (M2) no podría haber detectado:
//   - Coverage: cada escena tiene visual (imagePath/videoPath existe en disk)
//   - Duración: audio vs video vs sum(scene durations) coherentes
//   - Subtítulos: legibles, sin gibberish, idioma correcto
//   - Calidad final: muestra de frames pasa el judge Claude

import { z } from 'zod';

export const FinalIssueSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type FinalIssueSeverity = z.infer<typeof FinalIssueSeveritySchema>;

export const FinalIssueCategorySchema = z.enum([
  'missing-visual',          // scene sin imagePath ni videoPath en disk
  'missing-animation',       // scene tiene imagePath pero no videoPath (info, no error)
  'duration-mismatch',       // audio dura más/menos que sum de scenes
  'visual-quality',          // alguna scene reprobó el Claude judge
  'subtitle-quality',        // subs ilegibles, gibberish, idioma incorrecto
  'subtitle-timing',         // subs no sincronizan con audio
  'other',
]);
export type FinalIssueCategory = z.infer<typeof FinalIssueCategorySchema>;

export const FinalIssueSchema = z.object({
  severity: FinalIssueSeveritySchema,
  category: FinalIssueCategorySchema,
  sceneIndex: z.number().int().nullable(),
  description: z.string().min(5).max(800),
  suggestion: z.string().min(5).max(500).optional(),
});
export type FinalIssue = z.infer<typeof FinalIssueSchema>;

/**
 * Reporte que devuelve judgeFinalRender(). Captura el estado del video final
 * de manera estructurada y accionable.
 */
export const FinalRenderReportSchema = z.object({
  pass: z.boolean(),
  // Coverage
  totalScenes: z.number().int().min(0),
  scenesWithVideo: z.number().int().min(0),
  scenesWithStaticImageOnly: z.number().int().min(0),
  scenesMissingVisual: z.number().int().min(0),
  // Duración
  audioDurationSec: z.number().min(0),
  scenePlanDurationSec: z.number().min(0),
  videoFinalDurationSec: z.number().min(0).optional(),
  durationMismatchSec: z.number().optional(),
  // Visual quality sample
  visualSampleSize: z.number().int().min(0),
  visualSampleAvgScore: z.number().min(0).max(100).optional(),
  visualSampleFailures: z.number().int().min(0),
  // Subtítulos (si se valida)
  subtitleSampleSize: z.number().int().min(0).optional(),
  subtitleIssuesCount: z.number().int().min(0).optional(),
  // Resultado consolidado
  issues: z.array(FinalIssueSchema),
  rationale: z.string().min(10).max(1000),
});
export type FinalRenderReport = z.infer<typeof FinalRenderReportSchema>;

/**
 * Input para judgeFinalRender().
 */
export interface FinalRenderInput {
  runId: string;
  workDir: string;
  scenePlanPath?: string; // si se pasa, lee de disk; sino usa scenes
  scenes: Array<{
    index: number;
    text: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
    imagePath?: string;
    videoPath?: string;
    imagePrompt?: string;
  }>;
  audioPath?: string;
  finalVideoPath?: string;
  // Si se pasa, se valida subtitle quality con Claude (lenguaje, gibberish, ortografía).
  subtitleSegments?: Array<{ text: string; startSec: number; endSec: number }>;
  brandContext?: {
    brandId?: string;
    productName?: string;
    // 25-may-2026: productDescription es CRÍTICO para que el editor IA detecte
    // mismatches semánticos visual-producto. Ejemplo: si product.description dice
    // "suplemento sublingual" y visual muestra "echando en la mano" → critical issue.
    productDescription?: string;
    // Forma de uso esperada (sublingual / oral / tópico / spray / etc.) — si se
    // pasa, el editor IA verifica que el visual lo respete.
    productUsageForm?: string;
    styleSummary?: string;
    // Idioma esperado del ad (ISO 639-1: 'es', 'en', 'pt'). Lo usa el burned-text
    // detector para flagear texto en idioma incorrecto.
    language?: string;
  };
}

export interface FinalJudgeOptions {
  // Si true, samplea N escenas y las valida con Claude judge.
  // Si false, solo hace coverage + duration check (no costo Claude).
  // Default: true (asume API key disponible).
  useClaudeJudge?: boolean;
  // Cuántas escenas samplear para validar visualmente. Default 3.
  // Sample = primera + medio + última, más cualquier scene flagged como "critical".
  visualSampleSize?: number;
  // Threshold para failure de duración (en segundos). Default 1.5s.
  // Si abs(audio - scenePlan) > tolerance → flag duration-mismatch.
  durationToleranceSec?: number;
}
