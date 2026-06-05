// repair-plan.ts — la parte PURA del brazo (Fase 2 parte 2). Traduce una reparación
// dirigida (RepairTarget) a un plan de corrección determinista (CorrectionParse),
// SIN efectos: ni DB, ni IA, ni archivos. Vive aparte de repair-executor.ts para
// poder testearse en aislamiento (importar el executor arrastra db/correction-pipeline).
//
// Solo importa TIPOS → en runtime no carga ningún módulo pesado.

import type { CorrectionParse } from './correction-pipeline';
import type { RepairAction, RepairTarget } from './kb/quality-gate';

/** ¿La acción REGENERA una escena (la puede ejecutar el brazo)? Las de edición
 *  ('surface-to-editor') y sistémicas ('escalate') NO: van al editor / revisión. */
export function repairActionIsExecutable(action: RepairAction): boolean {
  return (
    action.kind === 'regenerate-image' ||
    action.kind === 'reanimate' ||
    action.kind === 'regenerate-scene'
  );
}

/**
 * Traduce una reparación dirigida a un plan de corrección DETERMINISTA para
 * applyCorrection. Devuelve null si la acción no regenera una escena concreta
 * (editor/escalar/sin escena) — el caller la trata como "no ejecutable".
 */
export function buildRepairParse(repair: RepairTarget): CorrectionParse | null {
  const { action, blocker } = repair;
  if (!repairActionIsExecutable(action)) return null;

  // sceneIndex: las acciones ejecutables lo llevan; si no, el del RepairTarget.
  const sceneIndex = 'sceneIndex' in action ? action.sceneIndex : repair.sceneIndex;
  if (typeof sceneIndex !== 'number') return null;

  // Dirección correctiva (lo que SÍ se quiere ver): el prompt corregido de la acción,
  // o el fix propuesto del hallazgo. applyCorrection lo inyecta como "CRITICAL FIX"
  // preservando la composición (defecto puntual de una escena).
  let dir = '';
  if (action.kind === 'regenerate-image') dir = action.correctedImagePrompt;
  else if (action.kind === 'reanimate') dir = action.correctedMotionPrompt;
  dir = (dir || blocker.fixPropuesto || blocker.titulo || 'corregir el defecto detectado').trim();

  return {
    startSec: blocker.startSec ?? 0,
    // endSec es informativo: pickAffectedScenes prioriza sceneIndices, no el rango.
    endSec: blocker.endSec ?? blocker.startSec ?? 0,
    sceneIndices: [sceneIndex],
    intent: 'regenerate',
    newDirection: dir.slice(0, 150),
    // Defecto puntual de UNA escena → preservar el hilo del video (mismo encuadre,
    // personajes, ambiente); solo se corrige el problema.
    preserveComposition: true,
    reasoning: `Reparación dirigida del gate (${blocker.dimension}).`,
  };
}
