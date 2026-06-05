// repair-loop.ts — Fase 2 del círculo de mejora ("Aplicar"), parte 1: el PLAN.
//
// Implementa planRepairs (la interfaz RepairLoop tipada en quality-gate.ts): traduce,
// de forma DETERMINISTA y sin re-llamar IA, cada bloqueante del veredicto a una
// reparación dirigida — según la DIMENSIÓN/especialista que lo emitió. NO ejecuta
// nada (invariante "nada se auto-aplica"): solo DECIDE qué haría falta, para que el
// owner lo apruebe. La ejecución/regeneración real es un paso posterior (executor).
//
// Targeting por ESCENA (Fase 2 "el brazo"): si el bloqueante trae sceneIndex (lo
// resuelve la compuerta desde el scene-plan.json del run), la reparación es DIRIGIDA:
//   - animación/movimiento → 'reanimate' SOLO esa escena
//   - defecto visual de la escena (realismo/persona/…) → 'regenerate-image' SOLO esa
// Si NO hay escena (o es de edición/sistémico), se mantiene el camino seguro:
//   - EDICIÓN (recorte/anotación/captions/producto) → 'surface-to-editor'
//   - SISTÉMICO (voces/fidelidad) o audio/lipsync    → 'escalate'
// Nada se ejecuta aquí: planRepairs solo DECIDE; el executor aplica con OK del owner.

import type { GateBlocker, QualityGateReport } from './findings';
import type { RepairAction, RepairLoop, RepairTarget } from './quality-gate';

/**
 * Rutea un hallazgo a (target, acción) de forma determinista. Si se conoce la
 * escena (sceneIndex), emite la reparación DIRIGIDA; si no, el camino seguro
 * (editor/escalar). `fix` (el fixPropuesto del hallazgo) se usa como dirección
 * correctiva del prompt cuando la acción regenera/re-anima.
 */
export function routeByDimension(
  dimension: string,
  sceneIndex: number | null = null,
  fix = '',
): {
  target: RepairTarget['target'];
  action: RepairAction;
} {
  const d = dimension.toLowerCase();

  // Capa de EDICIÓN: recorte/overlay, anotaciones, captions y legibilidad del
  // producto se arreglan moviendo/ajustando elementos en el editor (o el Copilot),
  // NO regenerando — aunque se conozca la escena. El comentario de RepairAction ya
  // marca recorte/caption/anotación como capa de edición (no auto).
  if (
    d.includes('composicion') ||
    d.includes('recorte') ||
    d.includes('caption') ||
    d.includes('anotacion') ||
    d.includes('producto') ||
    d.includes('legibilidad')
  ) {
    return { target: 'composite', action: { kind: 'surface-to-editor' } };
  }

  // Animación/movimiento: con escena conocida → re-animar SOLO esa; si no, se
  // surfacea al editor (donde se elige la escena a re-animar).
  if (d.includes('animacion') || d.includes('movimiento')) {
    if (typeof sceneIndex === 'number') {
      return {
        target: 'motion',
        action: { kind: 'reanimate', sceneIndex, correctedMotionPrompt: fix },
      };
    }
    return { target: 'motion', action: { kind: 'surface-to-editor' } };
  }

  // SISTÉMICO de verdad: voces/diarización (multi-voz) y fidelidad de formato NO se
  // arreglan regenerando una sola escena → revisión/regeneración mayor del owner.
  if (d.includes('voces') || d.includes('diariz') || d.includes('fidelidad')) {
    return { target: 'systemic', action: { kind: 'escalate' } };
  }

  // RESTO (render-av: realismo/persona/cara, o cualquier defecto visual de una
  // escena): con escena conocida → regenerar SOLO esa imagen, con el fix como
  // dirección. EXCEPCIÓN: lipsync/ritmo/audio/voz NO se arreglan regenerando una
  // imagen → escalar. Sin escena → escalar.
  const esAudioOSync = /(lipsync|labio|sincron|ritmo|audio|voz|pronunci|sonido)/i.test(
    `${d} ${fix}`,
  );
  if (typeof sceneIndex === 'number' && !esAudioOSync) {
    return {
      target: 'image',
      action: { kind: 'regenerate-image', sceneIndex, correctedImagePrompt: fix },
    };
  }
  return { target: 'systemic', action: { kind: 'escalate' } };
}

/** Traduce los bloqueantes de un reporte a reparaciones dirigidas (sin ejecutar). */
export function planRepairs(report: QualityGateReport): RepairTarget[] {
  return report.bloqueantes.map((blocker: GateBlocker): RepairTarget => {
    const sceneIndex = blocker.sceneIndex ?? null;
    const { target, action } = routeByDimension(blocker.dimension, sceneIndex, blocker.fixPropuesto);
    return { blocker, target, sceneIndex, action };
  });
}

/** Implementación de la interfaz RepairLoop (Fase 2 — solo el plan, sin executor). */
export const defaultRepairLoop: RepairLoop = { planRepairs };
