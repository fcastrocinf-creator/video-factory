// editor-verdict.ts — El "editor crítico" del M5.
//
// Después de los chequeos automáticos (coverage, duration, visual sample),
// llamamos a Claude para que actúe como un EDITOR PROFESIONAL viendo el
// reporte. NO un score numérico — un veredicto humano, conversacional, con
// criterio editorial.
//
// Tono esperado: "¿Cómo le vas a entregar este video al cliente si tiene X?"
//
// Output: { ready: boolean, verdict: string (lenguaje natural), actions: string[] }

import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import { judgeWithClaude } from '@video-factory/core';
import type { FinalRenderReport } from './types.js';

// M7 Pieza C v2 (25-may-2026): migrado a `judgeWithClaude` de @video-factory/core.
// El fetch + parser JSON + Zod safeParse antes inline ahora vive en el primitivo
// unificado, junto con los demás juezes (subtitle, editor-loop, preview).

export const EditorVerdictSchema = z.object({
  // ¿Está listo para entregar al cliente?
  ready: z.boolean(),
  // Veredicto en lenguaje natural, tono de editor profesional.
  // 2-4 oraciones máximo. Concreto, no genérico.
  verdict: z.string().min(20).max(1500),
  // Lista de acciones concretas. Si ready=true, puede ser [].
  actions: z.array(z.string().min(5).max(300)),
  // Severidad general percibida por el editor (independiente del score numérico).
  severity: z.enum(['publishable', 'minor-polish', 'needs-rework', 'block-shipping']),
});
export type EditorVerdict = z.infer<typeof EditorVerdictSchema>;

const EDITOR_SYSTEM_PROMPT = `Eres un EDITOR DE VIDEO senior con 15 años en publicidad digital para marcas D2C (TikTok/Reels/Shorts).

Tu cliente acaba de generar un ad con IA y te pide tu opinión profesional ANTES de subirlo a Meta Ads. Tu trabajo NO es darle un score numérico — es decirle en lenguaje claro y directo si el video está listo o no.

Recibes el REPORTE TÉCNICO de un validador automático con:
- Cuántas escenas tiene el video
- Cuántas se animaron vs quedaron estáticas
- Duración del audio vs del scene plan
- Issues detectados (críticos / warnings / info)
- Sample de scores visuales si aplica

Tu output debe ser EXCLUSIVAMENTE JSON sin markdown fences:

{
  "ready": boolean,           // ¿le entregás esto al cliente sí o no?
  "verdict": "texto natural", // 2-4 oraciones. Hablá como editor a colega, no como reporte técnico
  "actions": [string, ...],   // acciones concretas si ready=false. Vacío si ready=true.
  "severity": "publishable" | "minor-polish" | "needs-rework" | "block-shipping"
}

CRITERIOS DE EDITOR PROFESIONAL:

- **block-shipping** = no se entrega bajo ninguna circunstancia. Ejemplos:
  - Video se corta antes que termine el audio (negro con audio sonando) → BLOCK
  - >30% de escenas sin animación → BLOCK
  - Subtítulos critical issues (ortografía marca / idioma incorrecto) → BLOCK

- **needs-rework** = pedir regenerar antes de entregar. Ejemplos:
  - Una escena clave (hook/CTA) tiene calidad mala
  - 1-2 escenas estáticas cuando el preset era animado
  - Mismatch de duración 3-5s

- **minor-polish** = se puede entregar pero con observaciones. Ejemplos:
  - 1 subtítulo con typo menor
  - Score visual borderline en 1 escena no-crítica

- **publishable** = entregalo, está bien

TONO del verdict: hablale al cliente como editor a colega. Ejemplos del estilo correcto:

❌ MAL (técnico, frío):
"Se detectaron 1 critical, 3 warnings. El audio duration mismatch supera el threshold."

✅ BIEN (editor humano):
"Este video no se entrega así. La última escena se corta a los 35 segundos pero el audio sigue 5 segundos más en silencio negro — eso es un corte feo que el cliente va a notar inmediatamente. Hay que regenerar la última escena con duración correcta antes de subirlo."

✅ BIEN (editor humano, OK):
"Todo en orden. 15 de 15 escenas animadas, audio y visual cuadran. La calidad visual sostiene su línea Pixar parejo. Listo para Meta."

actions DEBE decir QUÉ hacer concreto, no genérico:
✅ "Regenerar scene_13 con endTimeSeconds = 41.2 para cubrir el audio completo"
✅ "Reemplazar 'Vitali' por 'Vitaly' en el subtítulo del segmento 7"
❌ "Mejorar la duración"
❌ "Revisar calidad visual"

Sé directo. Sin diplomacia innecesaria.`;

export interface EditorVerdictInput {
  report: FinalRenderReport;
  apiKey?: string;
  model?: string;
}

export async function buildEditorVerdict(
  input: EditorVerdictInput,
): Promise<Result<EditorVerdict, { type: string; message: string }>> {
  const apiKey = input.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = input.model ?? 'claude-haiku-4-5';

  // Resumen del report como bullet points para el editor (más claro que dumpJSON).
  const summaryLines: string[] = [];
  summaryLines.push(`Total de escenas: ${input.report.totalScenes}`);
  summaryLines.push(`Animadas (con MP4): ${input.report.scenesWithVideo}`);
  summaryLines.push(`Estáticas (solo PNG): ${input.report.scenesWithStaticImageOnly}`);
  summaryLines.push(`Sin visual: ${input.report.scenesMissingVisual}`);
  summaryLines.push(`Duración audio: ${input.report.audioDurationSec.toFixed(1)}s`);
  summaryLines.push(`Duración scenes: ${input.report.scenePlanDurationSec.toFixed(1)}s`);
  if (input.report.durationMismatchSec !== undefined) {
    summaryLines.push(
      `Mismatch duración: ${input.report.durationMismatchSec.toFixed(1)}s ${input.report.durationMismatchSec > 1.5 ? '⚠️' : ''}`,
    );
  }
  if (input.report.visualSampleAvgScore !== undefined) {
    summaryLines.push(
      `Score visual promedio (sample): ${input.report.visualSampleAvgScore.toFixed(0)}/100`,
    );
  }
  if (input.report.issues.length > 0) {
    summaryLines.push('');
    summaryLines.push(`ISSUES DETECTADOS (${input.report.issues.length}):`);
    for (const i of input.report.issues) {
      const scenePart = i.sceneIndex !== null ? ` [scene ${i.sceneIndex}]` : '';
      summaryLines.push(`  - [${i.severity}/${i.category}]${scenePart} ${i.description}`);
      if (i.suggestion) summaryLines.push(`    → sugerencia: ${i.suggestion}`);
    }
  } else {
    summaryLines.push('SIN ISSUES detectados por el validador automático.');
  }

  const userMessage = `Acabamos de generar un ad y antes de subirlo a Meta Ads necesito tu veredicto profesional.

REPORTE TÉCNICO DEL VALIDADOR AUTOMÁTICO:

${summaryLines.join('\n')}

Decime: ¿está listo para entregar? Si no, qué hay que hacer concretamente.

Devuelve SOLO el JSON estructurado.`;

  const result = await judgeWithClaude({
    apiKey,
    model,
    system: EDITOR_SYSTEM_PROMPT,
    userContent: userMessage,
    schema: EditorVerdictSchema,
    maxTokens: 1024,
    temperature: 0.2, // ligeramente creativo para tono natural, no determinístico
  });
  if (result.isErr()) {
    return err({ type: result.error.type, message: result.error.message });
  }
  return ok(result.value);
}
