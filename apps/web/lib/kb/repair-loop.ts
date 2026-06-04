// repair-loop.ts — Fase 2 del círculo de mejora ("Aplicar"), parte 1: el PLAN.
//
// Implementa planRepairs (la interfaz RepairLoop tipada en quality-gate.ts): traduce,
// de forma DETERMINISTA y sin re-llamar IA, cada bloqueante del veredicto a una
// reparación dirigida — según la DIMENSIÓN/especialista que lo emitió. NO ejecuta
// nada (invariante "nada se auto-aplica"): solo DECIDE qué haría falta, para que el
// owner lo apruebe. La ejecución/regeneración real es un paso posterior (executor).
//
// Límite honesto de hoy: el GateBlocker NO trae sceneIndex/timing (el panel emite
// texto + dimensión), así que todavía NO se puede targetear una escena concreta para
// regenerar. Por eso:
//   - dimensiones de EDICIÓN (recorte/anotación/captions/producto) → 'surface-to-editor'
//   - dimensiones SISTÉMICAS (voces/fidelidad/formato/realismo)    → 'escalate'
// Cuando el panel enriquezca los hallazgos con sceneIndex, routeByDimension podrá
// emitir regenerate-image/reanimate dirigidos (ya tipados en RepairAction).

import type { GateBlocker, QualityGateReport } from './findings';
import type { RepairAction, RepairLoop, RepairTarget } from './quality-gate';

/** Rutea una dimensión de hallazgo a (target, acción) de forma determinista. */
export function routeByDimension(dimension: string): {
  target: RepairTarget['target'];
  action: RepairAction;
} {
  const d = dimension.toLowerCase();

  // Capa de EDICIÓN: recorte/overlay, anotaciones, captions y legibilidad del
  // producto se arreglan moviendo/ajustando elementos en el editor (o el Copilot),
  // no regenerando. El comentario de RepairAction ya marca recorte/caption/anotación
  // como capa de edición (no auto).
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

  // Animación/movimiento: en cuanto el hallazgo traiga la escena será 'reanimate';
  // por ahora se surfacea al editor (donde se elige la escena a re-animar).
  if (d.includes('animacion') || d.includes('movimiento')) {
    return { target: 'motion', action: { kind: 'surface-to-editor' } };
  }

  // SISTÉMICO: voces/diarización (multi-voz, audio), fidelidad de formato,
  // cobertura/realismo global (render-av) → revisión/regeneración mayor del owner.
  return { target: 'systemic', action: { kind: 'escalate' } };
}

/** Traduce los bloqueantes de un reporte a reparaciones dirigidas (sin ejecutar). */
export function planRepairs(report: QualityGateReport): RepairTarget[] {
  return report.bloqueantes.map((blocker: GateBlocker): RepairTarget => {
    const { target, action } = routeByDimension(blocker.dimension);
    return { blocker, target, sceneIndex: null, action };
  });
}

/** Implementación de la interfaz RepairLoop (Fase 2 — solo el plan, sin executor). */
export const defaultRepairLoop: RepairLoop = { planRepairs };
