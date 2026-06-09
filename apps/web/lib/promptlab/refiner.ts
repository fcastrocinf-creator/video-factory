// refiner.ts — refina el prompt a partir del veredicto del juez (Claude).
// Ataca los criterios que fallaron sin perder lo que ya funcionaba.

import { z } from 'zod';
import { unifiedJudge } from '../unified-judge';
import type { JudgeVerdict, PromptLabMode } from './types';

const RefineSchema = z.object({
  refinedPrompt: z.string().min(30).max(1200),
  reasoning: z.string().max(400),
});

const SYSTEM = `Eres un experto en prompts para generadores de imagen (Imagen / Nano Banana / gpt-image). Refinas un prompt en INGLES para MAXIMIZAR el cumplimiento sin perder lo que ya estaba bien. Reglas: ataca primero los criterios que fallaron; sé concreto y visual; nunca pidas texto/captions en la imagen; mantén el encuadre vertical 9:16. Responde SOLO JSON: {"refinedPrompt":"...","reasoning":"..."}`;

export async function refinePromptForLab(
  prompt: string,
  verdict: JudgeVerdict,
  _mode: PromptLabMode,
): Promise<string> {
  const failed = verdict.failedCriteria.length > 0 ? verdict.failedCriteria.join(', ') : '(score general bajo)';
  const evidence = verdict.evidence.slice(0, 8).join('\n');
  const user = `PROMPT ACTUAL (inglés):
"""
${prompt}
"""

SCORE: ${verdict.score}/100
CRITERIOS QUE FALLARON: ${failed}
HINT DEL JUEZ: ${verdict.hint}
EVIDENCIA:
${evidence}

Refina el prompt en INGLÉS para subir el cumplimiento atacando lo que falló. Mantén el resto.`;

  const result = await unifiedJudge({
    roleSystemPrompt: SYSTEM,
    userContent: user,
    schema: RefineSchema,
    temperature: 0.3,
    maxTokens: 1000,
  });
  // Si no pudo refinar, devolvemos el mismo prompt (el bucle igual converge o agota).
  if (result.isErr()) return prompt;
  return result.value.refinedPrompt;
}
