// Laboratorio de Prompts — tipos compartidos.
//
// Un OBJETIVO (target) es lo que queremos lograr visualmente: puede venir de un
// keyframe de referencia (RIPEAR) o de una intención en texto (CREAR). El bucle
// genera un prompt, una IA con visión lo JUZGA contra una rúbrica por dimensión
// y refina hasta APROBAR por umbral (o agotar presupuesto). Fail-closed: si la
// IA no pudo evaluar, NO se aprueba (notVerified).

import { z } from 'zod';

export type PromptLabMode = 'ripear' | 'crear';

/** Un criterio de la rúbrica: una frase del estado CORRECTO esperado + peso. */
export const RubricCriterionSchema = z.object({
  id: z.string(),
  description: z.string(), // qué debe verse (estado correcto)
  weight: z.number().min(1).max(5),
  critical: z.boolean(), // si un crítico falla, NO se aprueba aunque promedie alto
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

/** El objetivo normalizado del bucle (sirve para RIPEAR y CREAR). */
export interface VisualTarget {
  mode: PromptLabMode;
  /** Intención NL (CREAR) o descripción del original (RIPEAR). */
  intention: string;
  /** RIPEAR: ruta al keyframe de referencia. */
  referenceImagePath?: string;
  rubric: RubricCriterion[];
  /** Prompt v1 (semilla). */
  basePrompt: string;
  /** Umbral de aprobación 0-100. */
  threshold: number;
  brandId?: string;
}

/** Veredicto de un juez (compuesto). Fail-closed: notVerified ⇒ no aprueba. */
export interface JudgeVerdict {
  score: number; // 0-100
  byDimension: Record<string, number>;
  approved: boolean;
  notVerified: boolean; // true si la IA NO pudo evaluar (no se aprueba)
  hint: string; // instrucción accionable para refinar
  failedCriteria: string[]; // ids/descr de criterios no cumplidos
  evidence: string[];
}

export type StopReason =
  | 'aprobado'
  | 'exhausto-presupuesto'
  | 'estancado'
  | 'fatal'
  | 'no-verificado';

export interface RefineIteration {
  iteration: number;
  prompt: string;
  score: number;
  approved: boolean;
  notVerified: boolean;
  hint: string;
  failedCriteria: string[];
  imagePath?: string;
}

export interface RefineResult {
  approved: boolean;
  notVerified: boolean;
  bestPrompt: string;
  bestScore: number;
  bestImagePath?: string;
  iterations: RefineIteration[];
  stopReason: StopReason;
}
