// types.ts — schemas del preview-judge v2 (27-may-2026)
//
// El "judge" es un agente IA (Claude Haiku 4.5 por default) que evalúa cada
// imagen generada y devuelve un veredicto estructurado: pass/regenerate +
// scores + issues + sugerencias concretas para mejorar el prompt si falla.
//
// v2 (27-may-2026): fortalecido drásticamente con criterios de:
//   - LÓGICA NARRATIVA (la imagen tiene sentido vs lo que dice el narrador?)
//   - CONTINUITY (consistente con scenes adyacentes?)
//   - VIVACIDAD (mid-action vs posing, basado en análisis de SOOMI)
//   - BRAND coherence (producto correcto, sin elementos competencia)
//   - Burned-in text (incluye glitchy, wrong-language, leaks de prompt)
//   - Anti-patterns específicos del análisis del SOOMI

import { z } from 'zod';

export const IssueSeveritySchema = z.enum(['minor', 'major', 'critical']);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const IssueCategorySchema = z.enum([
  'anatomy', // dedos, simetría, miembros extra/fusionados
  'style-drift', // prompt pidió acuarela y vino fotorrealista, etc.
  'text-gibberish', // texto inventado/ilegible incrustado
  'text-leaked', // texto burned-in: hex codes, "9/16", "Expression Sheet", etc.
  'composition', // sujeto cortado, mal encuadre, layout malo
  'brand', // producto inventado, packaging incorrecto, competidor mostrado
  'subject', // sujeto principal incorrecto o ausente
  'physics', // gravedad, sombras inconsistentes, perspectiva rota
  'logical-coherence', // la imagen no encaja con lo que dice el narrador (ej "solo unas gotas" + cuchara llena)
  'continuity', // personaje cambia ropa/edad entre scenes, setting incoherente
  'viveness', // pose estática "gallery mode" sin gesto en progreso, sin mid-action
  'narrative-beat', // imagen no comunica el rol narrativo (hook/problem/cta) que tiene en el video
  'other',
]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

export const JudgeIssueSchema = z.object({
  severity: IssueSeveritySchema,
  // v2: lenient — si Claude inventa una category, fallback a 'other'
  category: z
    .union([IssueCategorySchema, z.string()])
    .transform((v): IssueCategory => {
      if (typeof v === 'string' && !['anatomy', 'style-drift', 'text-gibberish', 'text-leaked', 'composition', 'brand', 'subject', 'physics', 'logical-coherence', 'continuity', 'viveness', 'narrative-beat', 'other'].includes(v)) {
        return 'other';
      }
      return v as IssueCategory;
    }),
  description: z.string().min(1).max(1000),
  // v2: si este issue parece sistémico (afecta a varias scenes), el judge
  // sugiere un patch al preset.promptTemplate para evitarlo en futuras.
  // .nullish() acepta tanto undefined como null (Sonnet manda null explícito).
  suggestedSystemicPatch: z.string().min(1).max(1500).nullish().transform((v) => v ?? undefined),
});
export type JudgeIssue = z.infer<typeof JudgeIssueSchema>;

/**
 * El veredicto que devuelve Claude para una imagen.
 * Si `pass=false`, el caller debe regenerar la imagen usando `suggestions`
 * para mejorar el prompt.
 */
// v2: helper para normalizar scores — Sonnet a veces devuelve scores fuera
// de rango o como strings ("90/100"). Aceptamos lenient.
const scoreSchema = z
  .union([z.number(), z.string()])
  .transform((v) => {
    if (typeof v === 'number') return Math.max(0, Math.min(100, v));
    const m = /(\d+)/.exec(v);
    return m ? Math.max(0, Math.min(100, parseInt(m[1] ?? '0', 10))) : 0;
  });

export const JudgeReportSchema = z.object({
  pass: z.boolean(),
  // Calidad técnica general (composición, iluminación, anatomía)
  scoreVisual: scoreSchema,
  // Qué tan bien encaja con el estilo/marca solicitados
  scoreBrandFit: scoreSchema,
  // Qué tan atractiva visualmente para captar atención en TikTok/Reels
  scoreHookStrength: scoreSchema,
  // v2: nuevos scores específicos
  scoreLogicalCoherence: scoreSchema.optional(),
  scoreViveness: scoreSchema.optional(),
  scoreContinuity: scoreSchema.optional(),
  issues: z.array(JudgeIssueSchema),
  // Sugerencias concretas para mejorar el prompt si pass=false
  suggestions: z.array(z.string().min(5).max(500)),
  rationale: z.string().min(10).max(1000),
});
export type JudgeReport = z.infer<typeof JudgeReportSchema>;

/**
 * Input para judgeImage(). v2: contexto extendido cross-scene.
 */
export interface JudgeInput {
  imageBuffer: Buffer;
  imageMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  prompt: string;
  sceneNarration?: string;
  brandContext?: {
    brandId?: string;
    palette?: string[];
    styleSummary?: string;
    productName?: string;
    productDescription?: string;
    productUsageForm?: string; // sublingual/oral/topical/spray — clave para detectar logical-coherence
    language?: string; // 'es', 'en' — para detectar text en idioma incorrecto
  };
  expectedStyle?: string; // ej. "watercolor sepia", "pixar 3d", "photorealistic UGC"
  // v2: contexto cross-scene para continuity + narrative coherence
  scenePosition?: {
    index: number;
    total: number;
    narrativeBeat?: 'hook' | 'problem' | 'mechanism' | 'demo' | 'product-reveal' | 'social-proof' | 'cta' | 'other';
    shotType?: string; // talking-head, anatomy, product, split-screen, comic-panel, action, infographic
  };
  // Resumen de las 2 scenes anteriores para validar continuity
  prevScenesContext?: Array<{
    index: number;
    visualDescription: string; // breve, max 200 chars
    narration: string; // texto narrado, max 100 chars
  }>;
  // Script completo (todas las narraciones concatenadas, max 2000 chars)
  scriptFullSummary?: string;
}

/**
 * Config del judge. Cada campo opcional con default razonable.
 */
export interface JudgeOptions {
  model?: string; // default 'claude-haiku-4-5'
  maxTokens?: number; // default 2048 (v2 subió por más output context)
  thresholds?: {
    minScoreVisual?: number; // default 80
    minScoreBrandFit?: number; // default 75
    minScoreHookStrength?: number; // default 70
    minScoreLogicalCoherence?: number; // default 80 (CRÍTICO — semantic match)
    minScoreViveness?: number; // default 60 (no requerimos perfección, solo no muerto)
    minScoreContinuity?: number; // default 70
    failOnAnyCritical?: boolean; // default true
  };
  apiKey?: string; // si no pasa, lee de process.env['ANTHROPIC_API_KEY']
  timeoutMs?: number; // default 30000
}

export interface JudgeError {
  type: 'no-api-key' | 'api-error' | 'parse-error' | 'timeout';
  message: string;
  detail?: string;
}
