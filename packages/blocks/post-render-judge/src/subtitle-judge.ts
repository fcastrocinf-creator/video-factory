// subtitle-judge.ts — usa Claude Haiku (sin imagen) para validar text quality
// de los subtítulos: detecta gibberish, ortografía mala, idioma incorrecto,
// frases sin sentido, palabras inventadas (típico TTS+ASR ruido).
//
// NO valida timing (eso es coverage de duration check) ni layout visual
// (eso requiere mirar el frame compuesto — M5 v2 con extracción de frames).
//
// M7 Pieza C v2 (25-may-2026): migrado a `judgeWithClaude` de @video-factory/core.
// El parsing JSON robusto, validación Zod y manejo de errores son del primitivo
// unificado — antes este archivo duplicaba ~60 líneas de plumbing.

import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import {
  judgeWithClaude,
  ANTHROPIC_URL,
  ANTHROPIC_VERSION,
} from '@video-factory/core';

export const SubtitleIssueSchema = z.object({
  segmentIndex: z.number().int(),
  severity: z.enum(['minor', 'major', 'critical']),
  kind: z.enum([
    'gibberish',     // texto sin sentido
    'misspelling',   // ortografía incorrecta
    'wrong-language',// idioma distinto al esperado
    'incomplete',    // frase cortada / sin sentido
    'invented-word', // palabra que no existe
    'punctuation',   // puntuación mala
    'other',
  ]),
  text: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
});
export type SubtitleIssue = z.infer<typeof SubtitleIssueSchema>;

export const SubtitleJudgeReportSchema = z.object({
  totalSegments: z.number().int(),
  issuesCount: z.number().int(),
  issues: z.array(SubtitleIssueSchema),
  overallScore: z.number().min(0).max(100), // 100 = todos los subs perfectos
  rationale: z.string(),
});
export type SubtitleJudgeReport = z.infer<typeof SubtitleJudgeReportSchema>;

export interface SubtitleJudgeInput {
  segments: Array<{ text: string; startSec: number; endSec: number }>;
  expectedLanguage?: string; // 'es' | 'es-CL' | 'en' etc. Default 'es'
  apiKey?: string;
  model?: string; // default 'claude-haiku-4-5'
}

// Re-export de las constantes Anthropic (compatibilidad histórica). Tras la
// migración a `judgeWithClaude` (M7 Pieza C v2) nadie las usa internamente; se
// mantienen exportadas por si algún caller externo las importa.
export const ANTHROPIC_URL_EXPORT = ANTHROPIC_URL;
export const ANTHROPIC_VERSION_EXPORT = ANTHROPIC_VERSION;

const SUBTITLE_SYSTEM_PROMPT = `Eres un editor de subtítulos para ads en español neutro (Latam) sobre productos de salud/belleza.

Tu tarea: validar UNA LISTA de subtítulos generados automáticamente por un sistema de speech-to-text. Detectas:
- Gibberish (texto sin sentido)
- Errores ortográficos
- Idioma incorrecto (debe ser español neutro)
- Frases incompletas o cortadas
- Palabras inventadas (alucinaciones del ASR)
- Puntuación incorrecta que rompa el significado

Respondé EXCLUSIVAMENTE con JSON válido sin markdown fences. Schema:

{
  "totalSegments": number,
  "issuesCount": number,
  "issues": [
    { "segmentIndex": number, "severity": "minor"|"major"|"critical", "kind": "gibberish"|"misspelling"|"wrong-language"|"incomplete"|"invented-word"|"punctuation"|"other", "text": "...", "description": "...", "suggestion": "..." (opcional) }
  ],
  "overallScore": 0-100,
  "rationale": "resumen 1-2 oraciones"
}

CRITERIOS:
- overallScore 100 = todos los subs perfectos sin issues
- Cada issue critical baja 10 puntos, major 5 puntos, minor 2 puntos
- "Vitali" en lugar de "Vitaly" es un misspelling MAJOR (afecta brand identity)
- Texto en otro idioma cuando se esperaba español = critical
- Tolera puntuación informal (subs sin punto final son OK)
- Tolera abreviaciones del lenguaje hablado ("pa'" en lugar de "para") si son intencionales

Sé estricto pero no nitpicky.`;

export async function judgeSubtitles(
  input: SubtitleJudgeInput,
): Promise<Result<SubtitleJudgeReport, { type: string; message: string; detail?: string }>> {
  // Short-circuit: sin segmentos, no llamamos a Claude
  if (input.segments.length === 0) {
    return ok({
      totalSegments: 0,
      issuesCount: 0,
      issues: [],
      overallScore: 100,
      rationale: 'Sin subtítulos para validar.',
    });
  }

  const apiKey = input.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = input.model ?? 'claude-haiku-4-5';
  const lang = input.expectedLanguage ?? 'es';
  const segmentsList = input.segments
    .map((s, i) => `[${i}] (${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s) "${s.text}"`)
    .join('\n');

  const userMessage = `Idioma esperado: ${lang}\n\nSubtítulos a validar (${input.segments.length} segmentos):\n${segmentsList}\n\nDevolvé el JSON estructurado.`;

  const result = await judgeWithClaude({
    apiKey,
    model,
    system: SUBTITLE_SYSTEM_PROMPT,
    userContent: userMessage,
    schema: SubtitleJudgeReportSchema,
    maxTokens: 2048,
    temperature: 0,
  });
  if (result.isErr()) {
    return err({
      type: result.error.type,
      message: result.error.message,
      detail: result.error.detail,
    });
  }
  return ok(result.value);
}
