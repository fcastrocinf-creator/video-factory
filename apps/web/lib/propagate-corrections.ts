// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PROPAGATE CORRECTIONS — v3.2 (29-may-2026)                              ║
// ║                                                                          ║
// ║  Cuando el owner aprueba/rechaza una scene con feedback substantivo,     ║
// ║  este helper toma ese feedback y reescribe los imagePrompts de las       ║
// ║  scenes futuras (no animadas todavía) para que incorporen la lección.    ║
// ║                                                                          ║
// ║  ¿Por qué? El scene-planner corre UNA sola vez al inicio del run. Los    ║
// ║  imagePrompts quedan congelados. Si el owner corrige algo en scene 1     ║
// ║  (por ejemplo: "no embarazada, sí hinchada"), scene 2 va a salir con el  ║
// ║  mismo problema porque su imagePrompt fue generado antes de la           ║
// ║  corrección. Esto rompe la sensación de "estamos co-creando" y           ║
// ║  multiplica el costo (cada scene necesita corrección manual).            ║
// ║                                                                          ║
// ║  La propagación se ejecuta DESPUÉS de cada Approve/Reject con comment    ║
// ║  o newImagePrompt, ANTES de que el scene-animator empiece la siguiente.  ║
// ║  Concurrency es 1 en modo colaborativo así que hay garantía de orden.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { z } from 'zod';
import { unifiedJudge } from './unified-judge';

export const PropagatedSceneSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  oldPrompt: z.string(),
  newPrompt: z.string(),
  changes: z.array(z.string()).default([]),
  unchanged: z.boolean().default(false),
});

export const PropagationSchema = z.object({
  updatedScenes: z.array(PropagatedSceneSchema),
  rationale: z.string(),
});

export type PropagatedScene = z.infer<typeof PropagatedSceneSchema>;
export type PropagationResult = z.infer<typeof PropagationSchema>;

const PROPAGATOR_SYSTEM_PROMPT = `Eres un propagador de correcciones para Video Factory.

El owner del proyecto acaba de dar feedback en una scene de un video vertical (ad TikTok/Reels para marcas D2C). Tu trabajo es decidir si esa corrección aplica a las scenes futuras que aún no se generaron, y si aplica, reescribir cada imagePrompt incorporando la lección.

Tienes:
- El comentario del owner (lo que estaba mal y lo que debería ser correcto)
- La lista de imagePrompts de las scenes futuras (con su narración para context)

Para cada scene futura:
1. Lee su imagePrompt y su narración
2. Decide si la corrección aplica:
   - Si la corrección habla de la APARIENCIA del PERSONAJE (edad, género, postura, expresión, estado físico) → aplica a TODAS las scenes que muestran a esa misma persona
   - Si la corrección habla del ESTILO VISUAL (acuarela, palette) → aplica a TODAS las scenes
   - Si la corrección habla de un OBJETO específico (un producto, un fondo) → aplica solo a scenes que lo muestren
   - Si la corrección es para una SCENE puntual (el baile, el contexto único) → NO aplica a las demás
3. Si APLICA: reescribe el imagePrompt incorporando la corrección. PRESERVA: estilo, paleta, narración, elementos no relacionados. CAMBIA solo lo necesario.
4. Si NO APLICA: marca unchanged=true y devuelve newPrompt = oldPrompt (no inventes correcciones).
5. La lista \`changes\` describe brevemente qué cambiaste (2-5 ítems en inglés cortos).

REGLAS CRÍTICAS:
- newPrompt DEBE estar en INGLÉS técnico (los providers de imagen funcionan mejor con inglés).
- NO agregues text overlays, hex codes, "Expression Sheet", o anti-patterns.
- PRESERVA descriptores válidos del original (paleta, estilo, narración).
- Si el owner dijo "X está mal, debería ser Y", REMUEVE descriptores de X y AGREGA descriptores de Y.
- Si la corrección menciona EDAD/GÉNERO/RAZA del personaje, propaga esa identidad a TODAS las scenes que muestren al mismo personaje (continuidad).
- En duda → unchanged=true (mejor conservador, no romper scenes que estaban bien).

Output SOLO JSON sin markdown fences:

{
  "updatedScenes": [
    {
      "sceneIndex": 2,
      "oldPrompt": "<el prompt original>",
      "newPrompt": "<el prompt corregido O igual si unchanged>",
      "changes": ["removed pregnant belly descriptor", "added water retention bloating"],
      "unchanged": false
    },
    {
      "sceneIndex": 3,
      "oldPrompt": "<…>",
      "newPrompt": "<igual al old>",
      "changes": [],
      "unchanged": true
    }
  ],
  "rationale": "<1-2 oraciones explicando tu lectura general>"
}`;

// v3.2 #138 audit: cap número de scenes en una sola llamada para no
// reventar el context de Claude (cada prompt puede ser ~2000 chars × 30
// scenes = 60k+ tokens). Si hay más, procesar en batches o conservar las
// scenes MÁS CERCANAS al feedback (mayor probabilidad de aplicar).
const MAX_SCENES_PER_PROPAGATION = 15;

export async function propagateCorrections(input: {
  apiKey: string;
  fromSceneIndex: number;
  ownerComment: string;
  scenesToEvaluate: Array<{ index: number; imagePrompt: string; text: string }>;
  brandContext?: {
    brandId?: string;
    productName?: string;
    styleSummary?: string;
    language?: string;
  };
  logger?: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
}): Promise<PropagationResult | null> {
  if (input.scenesToEvaluate.length === 0) return null;
  if (!input.apiKey || input.apiKey.startsWith('ROTATE_')) return null;

  // Cap scenes — si hay más de MAX, priorizamos las primeras (las que el
  // owner va a tocar más pronto). Las que quedan fuera mantienen su prompt
  // original — VALIDATOR de cada scene los va a corregir uno por uno cuando
  // se animen.
  const scenesUsed = input.scenesToEvaluate.slice(0, MAX_SCENES_PER_PROPAGATION);
  const droppedCount = input.scenesToEvaluate.length - scenesUsed.length;
  if (droppedCount > 0) {
    input.logger?.warn(
      {
        totalCandidates: input.scenesToEvaluate.length,
        usedInThisCall: scenesUsed.length,
        droppedCount,
        entity: 'PROPAGATE CORRECTIONS',
      },
      'propagate:capped_scene_count_for_context_budget',
    );
  }

  const userText = [
    `# Propagar corrección del owner a scenes futuras`,
    ``,
    `**Scene de origen (donde el owner dio feedback):** #${input.fromSceneIndex}`,
    ``,
    `## Comentario del owner:`,
    `"${input.ownerComment.slice(0, 1500)}"`,
    ``,
    input.brandContext?.brandId ? `**Brand:** ${input.brandContext.brandId}` : '',
    input.brandContext?.productName ? `**Producto:** ${input.brandContext.productName}` : '',
    input.brandContext?.styleSummary ? `**Estilo del preset:** ${input.brandContext.styleSummary}` : '',
    ``,
    `## ${scenesUsed.length} scenes futuras a evaluar:`,
    ``,
    ...scenesUsed.map((s) => {
      // v3.2 #138: avisar en log si se trunca el prompt para no romper context
      if (s.imagePrompt.length > 2000) {
        input.logger?.warn(
          { sceneIndex: s.index, fullLength: s.imagePrompt.length, entity: 'PROPAGATE CORRECTIONS' },
          'propagate:image_prompt_truncated_to_2000_chars',
        );
      }
      return `### Scene #${s.index}\n**Narración:** "${s.text.slice(0, 300)}"\n**imagePrompt actual:**\n${s.imagePrompt.slice(0, 2000)}\n`;
    }),
    ``,
    `Decide para cada una si la corrección aplica. Devuelve SOLO el JSON.`,
  ]
    .filter(Boolean)
    .join('\n');

  input.logger?.info(
    {
      fromSceneIndex: input.fromSceneIndex,
      candidatesCount: scenesUsed.length,
      droppedFromBudget: droppedCount,
      commentLength: input.ownerComment.length,
      entity: 'PROPAGATE CORRECTIONS',
    },
    'propagate:request_started',
  );

  const result = await unifiedJudge({
    apiKey: input.apiKey,
    model: 'claude-sonnet-4-5',
    maxTokens: 8000,
    temperature: 0.2,
    timeoutMs: 90_000,
    skipProjectContext: true,
    roleSystemPrompt: PROPAGATOR_SYSTEM_PROMPT,
    userContent: userText,
    schema: PropagationSchema,
  });

  if (result.isErr()) {
    input.logger?.warn(
      { err: result.error.message, entity: 'PROPAGATE CORRECTIONS' },
      'propagate:failed',
    );
    return null;
  }

  const propagated = result.value;
  const changedCount = propagated.updatedScenes.filter((s) => !s.unchanged).length;
  input.logger?.info(
    {
      fromSceneIndex: input.fromSceneIndex,
      candidatesCount: scenesUsed.length,
      changedCount,
      unchangedCount: scenesUsed.length - changedCount,
      entity: 'PROPAGATE CORRECTIONS',
    },
    'propagate:complete',
  );

  return propagated;
}
