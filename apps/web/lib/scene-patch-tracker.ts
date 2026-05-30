// scene-patch-tracker.ts — M7 #5 v2 — Loop scene-level → patch del preset
//
// Trackea suggestedSystemicPatch que el preview-judge emite cuando detecta
// problemas durante la generación de imágenes (image-gen-multi). Si el mismo
// patch (normalizado) aparece en 2+ scenes del mismo run, lo registra como
// propuesta en `storage/prompt-patches/proposals.jsonl` para que el owner
// revise y aplique en /admin "🧬 Cerebro evolutivo".
//
// Flujo (lo que el owner pidió):
//   image-gen-multi genera scene → preview-judge la evalúa → si problema parece
//   sistémico, propone un patch → trackeamos → si 2+ scenes confirman → patch
//   persiste como pending → owner aprueba → cerebro evolutivo aplica al code.
//
// Diseño: per-run-instance (un tracker por runId). No es global porque queremos
// detectar "este RUN tiene N scenes con el mismo bug" no "el sistema vio este
// patch N veces total".

import { recordProposedPatch, type SystemicPattern } from './prompt-evolution';
import { logSystemEvent } from './system-log';

const THRESHOLD_OCCURRENCES = 2; // 2+ scenes con el mismo patch → propuesta

interface PatchReport {
  patch: string;
  sceneIndex: number;
  severity: 'minor' | 'major' | 'critical';
  category: string;
  description: string;
}

interface PatchAccumulator {
  patch: string;
  category: string;
  scenes: number[];
  severities: string[];
  descriptions: string[];
}

/** Normaliza un patch para comparación: lowercase + collapse whitespace + trim */
function normalizePatch(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface ScenePatchTracker {
  /** Callback compatible con `ImageGenMultiBlockOptions.onSystemicPatchSuggested` */
  report: (info: PatchReport) => void;
  /** Snapshot del estado actual del tracker (para debugging / logging) */
  snapshot: () => PatchAccumulator[];
}

/**
 * Crea un tracker per-run. El callback emitido por el judge llama `report`
 * cada vez que detecta un patch sugerido. Cuando un patch (normalizado) llega
 * a THRESHOLD_OCCURRENCES, registra una propuesta en prompt-patches y emite
 * un evento al system-log para auditoría.
 *
 * Es seguro llamar `report` concurrentemente desde múltiples scenes en paralelo
 * (el Map es write-once-then-read; race acceptable porque solo cuenta).
 */
export function createScenePatchTracker(opts: {
  runId: string;
  presetId: string;
  brandId: string;
}): ScenePatchTracker {
  const accumulator = new Map<string, PatchAccumulator>();
  const alreadyRegistered = new Set<string>();

  function report(info: PatchReport): void {
    const key = normalizePatch(info.patch);
    if (!key || key.length < 10) return;

    let acc = accumulator.get(key);
    if (!acc) {
      acc = {
        patch: info.patch,
        category: info.category,
        scenes: [],
        severities: [],
        descriptions: [],
      };
      accumulator.set(key, acc);
    }
    // Solo contar UNA vez por scene (cada scene puede emitir el mismo patch
    // varias veces si se regenera N attempts).
    if (acc.scenes.includes(info.sceneIndex)) return;
    acc.scenes.push(info.sceneIndex);
    acc.severities.push(info.severity);
    acc.descriptions.push(info.description.slice(0, 200));

    // Si llegamos al threshold Y no lo registramos antes, persistir como pending
    if (acc.scenes.length >= THRESHOLD_OCCURRENCES && !alreadyRegistered.has(key)) {
      alreadyRegistered.add(key);
      void persistAsProposal(opts, acc, info);
    }
  }

  function snapshot(): PatchAccumulator[] {
    return [...accumulator.values()];
  }

  return { report, snapshot };
}

/**
 * Mapea la category del judge a la category del SystemicPattern schema.
 * El judge maneja más categorías (anatomy, viveness, etc.) que el SystemicPattern
 * (que es cross-cutting). Esta función agrupa.
 */
function mapToSystemicCategory(
  judgeCategory: string,
): SystemicPattern['category'] {
  if (judgeCategory === 'text-leaked' || judgeCategory === 'text-gibberish') return 'burned-in-text';
  if (judgeCategory === 'anatomy') return 'anatomy-error';
  if (judgeCategory === 'brand') return 'brand-incoherence';
  if (judgeCategory === 'logical-coherence') return 'brand-incoherence'; // mismatch semántico
  if (judgeCategory === 'continuity') return 'composition-error';
  if (judgeCategory === 'viveness') return 'visual-quality-low';
  if (judgeCategory === 'narrative-beat') return 'visual-quality-low';
  if (judgeCategory === 'composition') return 'composition-error';
  if (judgeCategory === 'style-drift') return 'visual-quality-low';
  return 'other';
}

async function persistAsProposal(
  opts: { runId: string; presetId: string; brandId: string },
  acc: PatchAccumulator,
  lastInfo: PatchReport,
): Promise<void> {
  const targetBlock: SystemicPattern['affectedBlock'] =
    acc.category === 'logical-coherence' || acc.category === 'viveness' || acc.category === 'narrative-beat'
      ? 'scene-planner'
      : acc.category === 'text-leaked' || acc.category === 'text-gibberish'
        ? 'scene-planner'
        : acc.category === 'anatomy'
          ? 'scene-planner'
          : 'image-gen-multi';

  // Construimos el SystemicPattern manualmente (no via detectSystemicPatterns
  // que escanea logs — acá tenemos datos en vivo de un run específico).
  const pattern: SystemicPattern = {
    patternId: `scene-level_${opts.runId.slice(0, 8)}_${acc.category}_${Date.now().toString(36)}`,
    category: mapToSystemicCategory(acc.category),
    affectedBlock: targetBlock,
    occurrenceCount: acc.scenes.length,
    affectedRunIds: [opts.runId.slice(0, 12)],
    description:
      `Patrón detectado en vivo durante run ${opts.runId.slice(0, 8)}: ${acc.scenes.length} scenes (${acc.scenes.join(', ')}) ` +
      `disparan el mismo problema sistémico — judge category "${acc.category}". ` +
      `Ejemplo: "${acc.descriptions[0]?.slice(0, 150)}"`,
    severityScore: acc.severities.reduce(
      (sum, s) => sum + (s === 'critical' ? 3 : s === 'major' ? 1.5 : 0.5),
      0,
    ),
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };

  // Para persistir un patch directo (no via Claude proposer), usamos
  // recordProposedPatch con los datos del judge ya formados como propuesta.
  // El judge ya hizo el trabajo de proponer el texto del patch.
  // NOTA: targetFilePath y targetPromptVarName se setean por defecto al
  // scene-planner. El owner puede redirigirlo si aplica mejor a otro bloque.
  try {
    const id = await recordProposedPatch({
      pattern,
      // Path apunta al scene-planner como heurística default — el owner puede
      // verificar en la UI y redirigir si conviene aplicar a otro bloque.
      targetFilePath: 'packages/blocks/scene-planner/src/block.ts',
      targetPromptVarName: 'systemInstruction',
      patchType: 'addition',
      oldText: null, // addition al final del template literal
      newText: '\n\n' + acc.patch,
      reasoning:
        `Detected by scene-level loop in run ${opts.runId.slice(0, 8)}. ${acc.scenes.length} scenes ` +
        `(${acc.scenes.join(', ')}) triggered the same issue category "${acc.category}". ` +
        `The judge proposed this patch text directly based on the issues seen.`,
      expectedImprovement: `Reduce ocurrencia de ${acc.category} en futuras scenes/runs`,
      confidence: 60, // moderado — patch viene del judge per-scene, no de Claude Sonnet con visión global
      proposedByModel: 'preview-judge (scene-level loop)',
    });
    void logSystemEvent({
      kind: 'config-changed',
      data: {
        triggerSource: 'scene-level-loop',
        proposalId: id,
        runId: opts.runId,
        presetId: opts.presetId,
        affectedScenes: acc.scenes,
        category: acc.category,
      },
      summary:
        `Scene-level loop propuso patch para ${acc.category} (${acc.scenes.length} scenes en run ${opts.runId.slice(0, 8)}). ` +
        `Pending en /admin para review.`,
    });
  } catch {
    // best-effort
  }
  void lastInfo; // referenced for type-check; could be used for extra metadata
}
