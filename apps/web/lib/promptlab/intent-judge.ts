// intent-judge.ts — el juez de CUMPLIMIENTO DE INTENCION (modo CREAR).
//
// Lo único realmente nuevo del Laboratorio. Dado una imagen + una rúbrica, la IA
// de visión (Claude Sonnet) puntúa CADA criterio 0-100. El AGREGADO se calcula
// de forma DETERMINISTA aquí (ponderado por peso) — no dependemos de que el
// modelo devuelva bien un "overall". Aprueba SOLO si el agregado supera el umbral
// Y todos los críticos pasan. FAIL-CLOSED: si la IA no pudo evaluar → notVerified.

import { z } from 'zod';
import { unifiedJudge, buildImageMessageContent, type ClaudeMessageContent } from '../unified-judge';
import type { JudgeVerdict, RubricCriterion } from './types';

/** Un criterio se considera "cumplido" a partir de este score. */
const PASS_MARK = 70;

// El modelo SOLO da score 0-100 + nota por criterio, y un hint. El overall y el
// pass los calculamos nosotros (más robusto que confiar en el modelo).
const IntentJudgeSchema = z.object({
  perCriterion: z
    .array(
      z.object({
        id: z.string(),
        score: z.coerce.number(),
        note: z.string().optional().default(''),
      }),
    )
    .min(1),
  hint: z.string().optional().default(''),
});

const SYSTEM = `Eres un juez visual ESTRICTO de cumplimiento de intención para ads. Recibes una imagen y una lista de criterios. Para CADA criterio das:
- score: NÚMERO ENTERO de 0 a 100 = qué tan bien se cumple ESE criterio EN LA IMAGEN (100 = perfecto; 0 = ausente o incorrecto). El "peso" del criterio es su IMPORTANCIA, NO es el score: NUNCA uses el peso como score.
- note: nota breve de lo que ves.
NO inventes cumplimiento: si un detalle pedido NO está, score bajo. Da también un "hint" con la mejora más importante.
Responde SOLO JSON válido (sin markdown), EXACTAMENTE con esta forma:
{"perCriterion":[{"id":"sujeto","score":92,"note":"..."}],"hint":"..."}`;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function judgeIntentCompliance(
  imageBuffer: Buffer,
  rubric: RubricCriterion[],
  threshold: number,
): Promise<JudgeVerdict> {
  const rubricText = rubric
    .map((c) => `- [${c.id}] (importancia ${c.weight}/5${c.critical ? ', CRITICO' : ''}) ${c.description}`)
    .join('\n');

  const content: ClaudeMessageContent[] = [
    {
      type: 'text',
      text: `Evalúa la IMAGEN generada contra estos criterios, dando un score 0-100 a cada uno:\n\n${rubricText}`,
    },
  ];
  content.push(...buildImageMessageContent(imageBuffer, '\nImagen a evaluar:', 'image/png'));

  const result = await unifiedJudge({
    roleSystemPrompt: SYSTEM,
    userContent: content,
    schema: IntentJudgeSchema,
    model: 'claude-sonnet-4-5',
    temperature: 0,
    maxTokens: 1500,
  });

  if (result.isErr()) {
    return {
      score: 0,
      byDimension: {},
      approved: false,
      notVerified: true,
      hint: `no se pudo evaluar la imagen (${result.error.type})`,
      failedCriteria: [],
      evidence: [],
    };
  }

  // Mapa de scores por id del modelo.
  const scoreById = new Map<string, { score: number; note: string }>();
  for (const pc of result.value.perCriterion) {
    scoreById.set(pc.id, { score: clamp(pc.score), note: pc.note });
  }

  // Agregado DETERMINISTA: ponderado por el peso de la rúbrica (no por lo que diga el modelo).
  const byDimension: Record<string, number> = {};
  const failedCriteria: string[] = [];
  const evidence: string[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  let criticalFailed = false;

  for (const c of rubric) {
    const got = scoreById.get(c.id);
    const s = got?.score ?? 0; // si el modelo no puntuó un criterio, cuenta como 0
    byDimension[c.id] = s;
    weightedSum += s * c.weight;
    weightTotal += c.weight;
    if (s < PASS_MARK) {
      failedCriteria.push(c.id);
      if (c.critical) criticalFailed = true;
    }
    evidence.push(`${c.id}: ${s}/100${got?.note ? ` — ${got.note}` : ''}`);
  }

  const overall = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  const approved = overall >= threshold && !criticalFailed;

  return {
    score: overall,
    byDimension,
    approved,
    notVerified: false,
    hint: result.value.hint || (failedCriteria.length ? `Mejorar: ${failedCriteria.join(', ')}` : ''),
    failedCriteria,
    evidence,
  };
}
