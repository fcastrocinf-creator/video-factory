// rubric.ts — convierte una INTENCION en lenguaje natural en (1) una rúbrica
// verificable por dimensión y (2) un prompt v1 para el generador de imagen.
// Es el "entender qué se debe mostrar" del flujo CREAR.

import { z } from 'zod';
import { unifiedJudge } from '../unified-judge';
import { RubricCriterionSchema, type RubricCriterion } from './types';

const RubricGenSchema = z.object({
  criteria: z.array(RubricCriterionSchema).min(2).max(10),
  basePrompt: z.string().min(40),
});

const SYSTEM = `Eres un director de arte para ads verticales 9:16. Conviertes una INTENCION de escena en:
1) RUBRICA: lista de 3-8 criterios visuales CONCRETOS y verificables en la imagen final. Cada criterio:
   - id: corto en minúsculas (ej "sujeto", "producto", "paleta", "mood", "fondo", "texto-limpio")
   - description: el ESTADO CORRECTO esperado en la imagen (una frase clara, sin ambigüedad)
   - weight: 1-5 (5 = imprescindible)
   - critical: true si sin él la escena NO sirve
   SIEMPRE incluye un criterio "texto-limpio" critical (la imagen NO debe tener texto/captions incrustados).
2) basePrompt: un prompt v1 en INGLES para un generador de imagen, detallado (sujeto, acción, props, encuadre 9:16, iluminación, paleta, mood, estilo foto/render), que NO pida texto en la imagen.
Responde SOLO JSON válido: {"criteria":[{"id","description","weight","critical"}],"basePrompt":"..."}`;

/** Deriva rúbrica + prompt v1 desde una intención NL. Fallback seguro si la IA falla. */
export async function buildRubricFromIntention(
  intention: string,
): Promise<{ rubric: RubricCriterion[]; basePrompt: string }> {
  const result = await unifiedJudge({
    roleSystemPrompt: SYSTEM,
    userContent: `INTENCION DE LA ESCENA (en español):\n${intention}`,
    schema: RubricGenSchema,
    model: 'claude-sonnet-4-5',
    temperature: 0.2,
    maxTokens: 1500,
  });
  if (result.isErr()) {
    // Fallback mínimo: no bloquea el Lab; el bucle igual generará y juzgará.
    return {
      rubric: [
        { id: 'fidelidad', description: `La imagen representa: ${intention}`, weight: 5, critical: true },
        { id: 'texto-limpio', description: 'La imagen NO tiene texto, captions ni marcas de agua incrustadas.', weight: 4, critical: true },
      ],
      basePrompt: `${intention}. Vertical 9:16, cinematic, no text, no captions, no watermark.`,
    };
  }
  return { rubric: result.value.criteria, basePrompt: result.value.basePrompt };
}
