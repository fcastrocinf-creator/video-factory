// Base de Conocimiento — Fase 0: emisores que reflejan a un sistema legacy Y a la KB.
// Centralizan el mapeo al esquema `Evento` (CONOCIMIENTO.md §2) para no repetir
// la lógica en cada call site. Best-effort en ambos lados: NUNCA rompen el flujo.

import { recordPresetJudgment } from '@video-factory/core';
import { recordEvent } from './record';

// Derivamos el tipo del input del propio `recordPresetJudgment` (sin depender de
// que el named type esté exportado del barrel de core).
type PresetJudgmentInput = Parameters<typeof recordPresetJudgment>[0];

const JUDGMENT_SEVERITY: Record<string, 'info' | 'low' | 'medium' | 'high'> = {
  approved: 'info',
  rejected: 'medium',
  edited: 'low',
  'run-success': 'info',
  'run-failed': 'high',
  'used-for-rip': 'info',
  other: 'info',
};

/**
 * Registra un juicio de preset (cerebro evolutivo M7 #3) Y lo refleja como
 * Evento en la Base de Conocimiento (vault `producto`, tipo `juicio-preset`).
 * Reemplaza las llamadas directas a `recordPresetJudgment` en apps/web para que
 * cada juicio quede también "registrado y ubicable" en el grafo. Devuelve el id
 * del juicio (o null si la persistencia legacy falló) — el reflejo a KB es
 * fire-and-forget y nunca afecta el retorno.
 */
export async function recordPresetJudgmentKb(
  entry: PresetJudgmentInput,
): Promise<string | null> {
  const id = await recordPresetJudgment(entry);
  try {
    const ctx = (entry.context ?? {}) as Record<string, unknown>;
    const brandId = typeof ctx['brandId'] === 'string' ? ctx['brandId'] : undefined;
    const runId = typeof ctx['runId'] === 'string' ? ctx['runId'] : undefined;
    void recordEvent({
      vault: 'producto',
      subsistema: 'aprendizaje',
      tipo: 'juicio-preset',
      entidad: { presetId: entry.presetId, brandId, runId },
      severidad: JUDGMENT_SEVERITY[entry.kind] ?? 'info',
      titulo: `Juicio de preset (${entry.kind}): ${entry.presetId}`,
      contenido:
        `Juicio **${entry.kind}** (weight ${entry.weight}) sobre el preset \`${entry.presetId}\`.` +
        (entry.notes ? `\n\n${entry.notes}` : '') +
        `\n\n\`\`\`json\n${JSON.stringify(ctx).slice(0, 600)}\n\`\`\``,
      fuente: `preset-judgment:${entry.kind}`,
      tags: ['juicio-preset', entry.kind],
    });
  } catch {
    // best-effort: el reflejo a la KB nunca debe interferir con el juicio.
  }
  return id;
}
