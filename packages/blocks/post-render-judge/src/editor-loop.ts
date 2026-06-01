// editor-loop.ts — El loop conversacional iterativo entre editor IA y pipeline.
//
// runEditorLoop(input, executor):
//   1. Llamar al editor IA con el reporte actual
//   2. Si action[0].type === 'approve' → return { approved: true }
//   3. Si action[0].type === 'manual-fix' → return { approved: false, manual: true }
//   4. Si action[0].type === 'extend-duration' → ejecutar via executor.extendDuration()
//   5. Re-render (responsibility del caller via executor.rerender)
//   6. Re-validar (responsibility del caller via executor.rerunM5)
//   7. Volver al paso 1 con el nuevo reporte
//   8. Max 3 iteraciones — si supera, return { approved: false, exhausted: true }

import { ok, err, type Result } from 'neverthrow';
import { judgeWithClaude } from '@video-factory/core';
import { EditorVerdictV2Schema, type EditorVerdictV2, type EditorAction } from './editor-actions.js';
import type { FinalRenderReport } from './types.js';

// Nota M7 Pieza C v2 (25-may-2026): este archivo antes hacía fetch raw a la
// Anthropic API + parser JSON robusto + Zod safeParse a mano. Ahora todo eso
// pasa por `judgeWithClaude` de @video-factory/core, que centraliza el
// patrón (incluyendo el extractor JSON tolerante a markdown fences + texto
// natural antes/después del objeto).

const MAX_ITERATIONS = 3;

const EDITOR_V2_SYSTEM_PROMPT = `Eres un EDITOR DE VIDEO senior con 15 años en publicidad digital D2C (TikTok/Reels).

Tu cliente generó un ad con IA y tú eres el QC final antes de Meta Ads. NO solo opinas — emites ACCIONES ESTRUCTURADAS que el pipeline ejecuta automáticamente. Esto es un loop iterativo: el pipeline ejecuta tus acciones, re-renderiza, te muestra el nuevo reporte, tú validas de nuevo, hasta aprobar.

IDIOMA: escribe SIEMPRE en español neutro (formas con "tú"). NUNCA uses voseo argentino (nada de sos/tenés/verificá/emití/usá/ejecutá). Esto aplica al campo "verdict" y a TODO el texto que generes.

**ESPECIALMENTE crítico:** verifica la COHERENCIA SEMÁNTICA entre la NARRACIÓN, el VISUAL y la NATURALEZA DEL PRODUCTO. Ejemplos de bugs lógicos que tienes que detectar:
- Si el producto es un suplemento sublingual / oral y el visual muestra a alguien echándose el contenido en la mano → CRITICAL (la mano no se traga)
- Si el producto es una crema y el visual lo muestra como bebida → CRITICAL
- Si la narración dice "solo unas gotas" y el visual muestra una cucharada → MAJOR
- Si la narración dice "rostro firme" y el visual muestra abdomen → MAJOR
- Si el producto es para mujeres 40+ y el visual muestra a una adolescente → MAJOR

Si detectas un mismatch así, emite "manual-fix" o "regenerate-scene" con prompt corregido — el pipeline no puede arreglar coherencia semántica con extend/trim.

**Sobre timing por escena:** si ves issues "duration-mismatch" a nivel scene (no solo total) → la voz va más rápido que el tiempo asignado a la imagen. Ejecuta extend-duration en esa scene específica para que la imagen acompañe la narración correctamente.

**Animación desactivada a propósito:** si el reporte indica que la animación se desactivó a propósito (el usuario eligió "sin animación"), las escenas estáticas son el RESULTADO DESEADO. NO lo marques como problema ni escales a manual-fix por "falta de animación".

Recibes el reporte técnico de un validador automático con:
- Cantidad de escenas, cuántas animadas vs estáticas
- Duración del audio vs scene plan
- Issues detectados (critical/warning/info)
- Iteración actual del loop (1, 2, o 3)

Devuelves EXCLUSIVAMENTE JSON sin markdown:

{
  "verdict": "texto natural 2-3 oraciones — háblale al pipeline como editor",
  "severity": "publishable" | "minor-polish" | "needs-rework" | "block-shipping",
  "actions": [
    // UNA acción del array (procesamos la primera):
    { "type": "extend-duration",    "sceneIndex": N, "newEndTimeSeconds": X.X, "reason": "..." },
    { "type": "trim-duration",      "sceneIndex": N, "newEndTimeSeconds": X.X, "reason": "..." },
    { "type": "regenerate-scene",   "sceneIndex": N, "newImagePrompt": "..." (opcional), "reAnimate": true, "reason": "..." },
    { "type": "adjust-prompt",      "sceneIndex": N, "newImagePrompt": "...", "reason": "..." },
    { "type": "approve",            "reason": "..." },
    { "type": "manual-fix",         "reason": "...", "humanSteps": ["...", "..."] }
  ]
}

REGLAS PARA EMITIR ACCIONES:

1. **approve** — TODO está OK (sin issues critical, scores >= 80, audio cuadra con scenes). El loop termina, run = completed.

2. **extend-duration** — audio dura MÁS que scenes (mismatch positivo). Extender la última scene cubre el gap. Da números exactos.

3. **trim-duration** — scenes duran MÁS que audio (mismatch negativo). Recortar la última scene al final del audio. Da números exactos.

4. **regenerate-scene** — UNA scene tiene calidad visual mala (score <70) o no se animó cuando debía. Pides regenerar (opcionalmente con prompt nuevo). NOTA: cuesta tokens extras.

5. **adjust-prompt** — UNA scene tiene visual OK pero el prompt necesita refinarse para próxima generación (ej. brand mismatch del producto). No re-renderiza ahora; queda guardado para futuro.

6. **manual-fix** — problema GRAVE que NO puedes arreglar:
   - Múltiples scenes sin animación cuando SÍ se esperaba animar (probable quota provider agotada) — NO aplica si la animación se desactivó a propósito
   - Múltiples scenes con calidad mala (problema sistémico del preset)
   - Subtítulos con typos críticos (idioma incorrecto)
   Pasas humanSteps específicos. Run = failed con tu veredicto.

7. En **iteración 3** (última), si todavía hay problemas → "manual-fix" obligatorio. NO retries infinitos.

PRIORIDADES de elección:
- Bug de duración → SIEMPRE extend o trim (es barato y rápido)
- Calidad de 1-2 scenes → regenerate-scene
- Calidad sistémica (>3 scenes mal) → manual-fix (es problema del preset, no fixeable per-scene)

EJEMPLO de cómo emitir extend-duration:
Si el reporte dice "audio 42.0s, scene plan 35.0s, scene 14 termina a 35.0s":
→ action { "type": "extend-duration", "sceneIndex": 14, "newEndTimeSeconds": 42.0, "reason": "scene 14 termina 7s antes que el audio — extender cubre el gap" }

EJEMPLO de approve:
Reporte sin issues → { "verdict": "Listo. Audio y video cuadran, 15/15 animadas, score 92.", "severity": "publishable", "actions": [{ "type": "approve", "reason": "sin issues detectados" }] }

EJEMPLO de manual-fix:
Reporte con 5 escenas estáticas → { "verdict": "5 escenas no se animaron — esto requiere recarga de saldo Kling o aumento de quota Veo, no puedo arreglarlo desde el loop", "severity": "needs-rework", "actions": [{ "type": "manual-fix", "reason": "fallback masivo de animación", "humanSteps": ["Verificar saldo Kling en app.klingai.com", "Pedir aumento de quota Veo en GCP Console", "Re-lanzar el run"] }] }

Sé directo y específico con los números. NO inventes — solo emite acciones cuando el reporte da datos exactos.`;

export interface EditorLoopExecutor {
  // El pipeline ejecuta esta acción y devuelve el nuevo reporte.
  // Si la acción no es reparable automáticamente, devolver el report sin cambios.
  executeAction: (action: EditorAction) => Promise<FinalRenderReport>;
}

export interface EditorLoopResult {
  approved: boolean;
  iterations: number;
  finalVerdict: EditorVerdictV2 | null;
  exhausted: boolean;     // true si llegó al cap sin aprobar
  manualFixRequired: boolean;
  conversation: Array<{
    iteration: number;
    report: FinalRenderReport;
    verdict: EditorVerdictV2;
  }>;
}

async function callEditorV2(
  report: FinalRenderReport,
  iteration: number,
  apiKey: string,
  model: string,
  projectContext?: string,
): Promise<Result<EditorVerdictV2, { type: string; message: string }>> {
  const summaryLines: string[] = [];
  summaryLines.push(`ITERACIÓN ${iteration} de ${MAX_ITERATIONS}`);
  summaryLines.push('');
  summaryLines.push(`Total escenas: ${report.totalScenes}`);
  summaryLines.push(`Animadas: ${report.scenesWithVideo}`);
  summaryLines.push(`Estáticas: ${report.scenesWithStaticImageOnly}`);
  summaryLines.push(`Sin visual: ${report.scenesMissingVisual}`);
  if (report.animationDisabled) {
    summaryLines.push(
      'NOTA: la animación se DESACTIVÓ a propósito en este run. Las escenas estáticas son el resultado deseado — NO es un fallo y NO debes escalar por "falta de animación".',
    );
  }
  summaryLines.push(`Audio dur: ${report.audioDurationSec.toFixed(1)}s`);
  summaryLines.push(`Scene plan dur: ${report.scenePlanDurationSec.toFixed(1)}s`);
  if (report.durationMismatchSec !== undefined) {
    summaryLines.push(`Mismatch: ${report.durationMismatchSec.toFixed(1)}s`);
  }
  if (report.visualSampleAvgScore !== undefined) {
    summaryLines.push(`Score visual avg: ${report.visualSampleAvgScore.toFixed(0)}/100`);
  }
  if (report.issues.length > 0) {
    summaryLines.push('');
    summaryLines.push(`ISSUES (${report.issues.length}):`);
    for (const i of report.issues) {
      const sp = i.sceneIndex !== null ? ` [scene ${i.sceneIndex}]` : '';
      summaryLines.push(`  - [${i.severity}/${i.category}]${sp} ${i.description}`);
    }
  } else {
    summaryLines.push('Sin issues detectados.');
  }

  const userMessage = `Reporte del validador automático:\n\n${summaryLines.join('\n')}\n\n¿Apruebas, ejecutas una acción reparadora, o escalas a manual-fix? Devuelve el JSON.`;

  // M9: si el caller pasó projectContext, prepend al system prompt del rol.
  const fullSystem = projectContext
    ? `${projectContext}\n\n---\n\n# Tu rol actual\n\n${EDITOR_V2_SYSTEM_PROMPT}`
    : EDITOR_V2_SYSTEM_PROMPT;

  const result = await judgeWithClaude({
    apiKey,
    model,
    system: fullSystem,
    userContent: userMessage,
    schema: EditorVerdictV2Schema,
    maxTokens: 1500,
    temperature: 0.2,
  });
  if (result.isErr()) {
    return err({
      type: result.error.type,
      message: result.error.message,
    });
  }
  return ok(result.value);
}

/**
 * Loop iterativo principal. El caller pasa el reporte inicial + un executor
 * que sabe ejecutar las acciones. Devuelve el resultado consolidado.
 */
export async function runEditorLoop(
  initialReport: FinalRenderReport,
  executor: EditorLoopExecutor,
  options: {
    apiKey?: string;
    model?: string;
    /** M9: contexto del proyecto pre-formateado para enriquecer el system prompt */
    projectContext?: string;
  } = {},
): Promise<Result<EditorLoopResult, { type: string; message: string }>> {
  const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    return err({ type: 'no-api-key', message: 'ANTHROPIC_API_KEY no configurada' });
  }
  const model = options.model ?? 'claude-haiku-4-5';
  const conversation: EditorLoopResult['conversation'] = [];
  let report = initialReport;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const verdictResult = await callEditorV2(report, iter, apiKey, model, options.projectContext);
    if (verdictResult.isErr()) return err(verdictResult.error);
    const verdict = verdictResult.value;
    conversation.push({ iteration: iter, report, verdict });

    // Procesar la primera acción del array
    const firstAction = verdict.actions[0];
    if (!firstAction) {
      // No debería pasar (schema requiere min(1)), pero defensivo
      return ok({
        approved: false,
        iterations: iter,
        finalVerdict: verdict,
        exhausted: false,
        manualFixRequired: true,
        conversation,
      });
    }

    if (firstAction.type === 'approve') {
      return ok({
        approved: true,
        iterations: iter,
        finalVerdict: verdict,
        exhausted: false,
        manualFixRequired: false,
        conversation,
      });
    }

    if (firstAction.type === 'manual-fix') {
      return ok({
        approved: false,
        iterations: iter,
        finalVerdict: verdict,
        exhausted: false,
        manualFixRequired: true,
        conversation,
      });
    }

    // Cualquier OTRA acción (extend-duration, trim-duration, regenerate-scene,
    // adjust-prompt) → ejecutar via executor y continuar loop con nuevo reporte.
    // El check de tipo `approve` y `manual-fix` ya pasó arriba.
    // Bug fix 25-may-2026: antes solo se manejaba 'extend-duration' explícito —
    // trim-duration y otros eran silenciosamente ignorados, el loop hacía las
    // 3 iteraciones pidiendo lo mismo sin ejecutar nada.
    try {
      report = await executor.executeAction(firstAction);
    } catch (e) {
      return err({
        type: 'execute-error',
        message: `Falla ejecutando ${firstAction.type}: ${(e as Error).message}`,
      });
    }
    // Continue loop con el nuevo reporte
  }

  // Llegamos al cap sin aprobar
  return ok({
    approved: false,
    iterations: MAX_ITERATIONS,
    finalVerdict: conversation[conversation.length - 1]?.verdict ?? null,
    exhausted: true,
    manualFixRequired: true,
    conversation,
  });
}
