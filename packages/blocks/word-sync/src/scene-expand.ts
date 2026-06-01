// Cap 4 — Expansión de escenas en micro-escenas sincronizadas a la narración.
//
// Cuando el guion enumera ("recorre tu cara, tu abdomen y tus piernas"), la
// escena que cubre esa enumeración se PARTE en N micro-escenas, una por ítem,
// con start/endTimeSeconds EXACTOS (de los timestamps por palabra). El compositor
// ya respeta duraciones por escena, así que el corte cae justo en la palabra.
//
// Pura y genérica (opera sobre cualquier objeto con la forma TimedScene) para
// poder testearla sin red y para no acoplar el block a @video-factory/contracts.

import type { WordTiming, MicroScene } from './types.js';
import { planMicroScenes, type DetectOptions } from './micro-scenes.js';

export interface TimedScene {
  index: number;
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  imagePrompt: string;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Expande las escenas que contienen una enumeración en micro-escenas sincronizadas
 * a cada palabra. Si no hay enumeraciones, devuelve las escenas intactas (no-op).
 * Conserva todos los campos extra de cada escena (componentType, editStep, etc.).
 */
export function expandEnumerationScenes<T extends TimedScene>(
  scenes: T[],
  words: WordTiming[],
  opts: DetectOptions = {},
  // Selección del usuario (Parte 3): si se da, SOLO se expanden las escenas cuyo
  // índice esté en la lista. null/undefined = expandir todas (comportamiento previo).
  allowedSceneIndices?: number[] | null,
): T[] {
  const micros = planMicroScenes(words, opts);
  if (micros.length === 0) return scenes;
  const allow = allowedSceneIndices == null ? null : new Set(allowedSceneIndices);

  // Agrupar micro-escenas por enumeración.
  const groups = new Map<number, MicroScene[]>();
  for (const m of micros) {
    const arr = groups.get(m.enumerationStart) ?? [];
    arr.push(m);
    groups.set(m.enumerationStart, arr);
  }

  let result = [...scenes];
  for (const items of groups.values()) {
    items.sort((a, b) => a.start - b.start);
    const enumStart = items[0]!.start;
    // Escena que CONTIENE temporalmente el inicio de la enumeración.
    const idx = result.findIndex(
      (s) => s.startTimeSeconds <= enumStart + 0.05 && s.endTimeSeconds >= enumStart - 0.05,
    );
    if (idx < 0) continue;
    const parent = result[idx]!;
    // Selección del usuario: si hay lista y esta escena no fue elegida, la dejamos intacta.
    if (allow && !allow.has(parent.index)) continue;
    const replacement: T[] = [];

    // Cabeza opcional: lo que la escena dice ANTES de la enumeración (si dura algo).
    if (enumStart - parent.startTimeSeconds >= 0.4) {
      replacement.push({ ...parent, endTimeSeconds: round3(enumStart) });
    }

    // Una micro-escena por ítem, con ventana exacta de su palabra.
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const end =
        i < items.length - 1 ? items[i + 1]!.start : Math.max(it.end, parent.endTimeSeconds);
      replacement.push({
        ...parent,
        text: it.item,
        startTimeSeconds: round3(it.start),
        endTimeSeconds: round3(end),
        imagePrompt: `${parent.imagePrompt} — extreme close-up focusing on: ${it.anchor}`,
      });
    }

    result = [...result.slice(0, idx), ...replacement, ...result.slice(idx + 1)];
  }

  // Re-indexar para mantener índices contiguos.
  return result.map((s, i) => ({ ...s, index: i }));
}
