// Composition Memory: knowledge base de las CORRECCIONES MANUALES que el usuario
// hace en el editor de composición (Fase 4 del orquestador).
//
// Filosofía: cada vez que el usuario ajusta la geometría que la IA propuso —
// mueve un panel, lo agranda, lo rota — registramos el par (lo que la IA generó
// ↔ lo que el humano corrigió). Con el tiempo, el detector de geometría recibe
// estas correcciones como ejemplos few-shot en su prompt y aprende a proponer
// composiciones más cercanas a lo que el usuario realmente quiere — hasta que
// el modo automático acierta solo.
//
// Storage: append-only JSONL en storage/composition-memory/corrections.jsonl,
// mismo enfoque que error-memory.ts.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RectSnapshot {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
}

// Corrección de UN elemento: lo que la IA propuso vs. lo que el humano dejó.
export interface ElementCorrection {
  elementId: string;
  kind: string;
  aiRect: RectSnapshot;
  humanRect: RectSnapshot;
  aiRotationDeg?: number;
  humanRotationDeg?: number;
  aiOpacity?: number;
  humanOpacity?: number;
  aiZIndex?: number;
  humanZIndex?: number;
  // true si el elemento es nuevo (lo agregó el humano, no existía en la propuesta IA).
  addedByHuman?: boolean;
  // true si el humano eliminó un elemento que la IA había propuesto.
  removedByHuman?: boolean;
}

export interface CompositionCorrectionEntry {
  id: string;
  correctedAt: string; // ISO timestamp
  runId?: string;
  brand?: string;
  preset?: string;
  sceneIndex: number;
  // Narración de la escena — contexto para matchear correcciones relevantes.
  narration: string;
  // Correcciones por elemento.
  elementCorrections: ElementCorrection[];
  // Resumen legible de la corrección (se usa como ejemplo few-shot).
  summary: string;
}

function defaultCompositionMemoryPath(): string {
  return resolve(process.cwd(), 'storage', 'composition-memory', 'corrections.jsonl');
}

/**
 * Registra una corrección de composición. Append-only.
 * Devuelve el id, o null si no había correcciones reales que registrar.
 */
export async function recordCompositionCorrection(
  entry: Omit<CompositionCorrectionEntry, 'id' | 'correctedAt'>,
  options: { path?: string } = {},
): Promise<string | null> {
  if (entry.elementCorrections.length === 0) return null;
  const path = options.path ?? defaultCompositionMemoryPath();
  await mkdir(dirname(path), { recursive: true });
  const full: CompositionCorrectionEntry = {
    ...entry,
    id: randomUUID(),
    correctedAt: new Date().toISOString(),
  };
  await appendFile(path, JSON.stringify(full) + '\n', 'utf-8');
  return full.id;
}

export async function loadAllCompositionCorrections(
  options: { path?: string } = {},
): Promise<CompositionCorrectionEntry[]> {
  const path = options.path ?? defaultCompositionMemoryPath();
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as CompositionCorrectionEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is CompositionCorrectionEntry => x !== null);
}

/**
 * Correcciones relevantes para un contexto. Matchea por brand/preset y por
 * solapamiento de palabras de la narración. Devuelve las top-K más recientes
 * entre las relevantes (las recientes reflejan mejor la preferencia actual).
 */
export async function queryRelevantCompositionCorrections(opts: {
  narration?: string;
  brand?: string;
  preset?: string;
  topK?: number;
  path?: string;
}): Promise<CompositionCorrectionEntry[]> {
  const all = await loadAllCompositionCorrections({ path: opts.path });
  if (all.length === 0) return [];
  const k = opts.topK ?? 6;
  const narrationWords = new Set(
    (opts.narration ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4),
  );

  const scored = all
    .map((e) => {
      let score = 0;
      if (opts.brand && e.brand === opts.brand) score += 3;
      if (opts.preset && e.preset === opts.preset) score += 2;
      if (narrationWords.size > 0) {
        const entryWords = e.narration.toLowerCase().split(/\s+/);
        for (const w of entryWords) {
          if (narrationWords.has(w)) score += 1;
        }
      }
      // Recencia: las correcciones recientes pesan un poco más.
      const ageMs = Date.now() - new Date(e.correctedAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 7) score += 1;
      return { e, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ e }) => e);

  return scored;
}

/**
 * Bloque de texto para inyectar en el prompt del detector de geometría. Resume
 * cómo el usuario suele corregir las composiciones que la IA propone, para que
 * el detector ajuste sus estimaciones. String vacío si no hay correcciones.
 */
export function formatCompositionLessons(entries: CompositionCorrectionEntry[]): string {
  if (entries.length === 0) return '';
  const lessons = entries.slice(0, 6).map((e, i) => `${i + 1}. ${e.summary}`);
  return `\n\nLEARNED FROM PAST MANUAL CORRECTIONS (the user adjusted the AI's geometry like this — bias your estimates toward these patterns):\n${lessons.join('\n')}`;
}

/**
 * Compara la composición que la IA propuso con la que el humano dejó y devuelve
 * la lista de correcciones por elemento. Usada por el endpoint de guardado.
 */
export interface ComposedElementLike {
  id: string;
  kind: string;
  rect: RectSnapshot;
  rotationDeg?: number;
  opacity?: number;
  zIndex?: number;
}

const EPS = 0.5; // tolerancia en % / grados — por debajo no se considera corrección

export function diffComposition(
  aiElements: ComposedElementLike[],
  humanElements: ComposedElementLike[],
): { corrections: ElementCorrection[]; summary: string } {
  const corrections: ElementCorrection[] = [];
  const aiById = new Map(aiElements.map((e) => [e.id, e]));
  const humanById = new Map(humanElements.map((e) => [e.id, e]));

  for (const h of humanElements) {
    const ai = aiById.get(h.id);
    if (!ai) {
      // Elemento nuevo agregado por el humano.
      corrections.push({
        elementId: h.id,
        kind: h.kind,
        aiRect: h.rect,
        humanRect: h.rect,
        addedByHuman: true,
      });
      continue;
    }
    const movedX = Math.abs(ai.rect.xPct - h.rect.xPct) > EPS;
    const movedY = Math.abs(ai.rect.yPct - h.rect.yPct) > EPS;
    const resizedW = Math.abs(ai.rect.widthPct - h.rect.widthPct) > EPS;
    const resizedH = Math.abs(ai.rect.heightPct - h.rect.heightPct) > EPS;
    const rotated = Math.abs((ai.rotationDeg ?? 0) - (h.rotationDeg ?? 0)) > EPS;
    const reopacity = Math.abs((ai.opacity ?? 1) - (h.opacity ?? 1)) > 0.02;
    const restacked = (ai.zIndex ?? 0) !== (h.zIndex ?? 0);
    if (movedX || movedY || resizedW || resizedH || rotated || reopacity || restacked) {
      corrections.push({
        elementId: h.id,
        kind: h.kind,
        aiRect: ai.rect,
        humanRect: h.rect,
        aiRotationDeg: ai.rotationDeg,
        humanRotationDeg: h.rotationDeg,
        aiOpacity: ai.opacity,
        humanOpacity: h.opacity,
        aiZIndex: ai.zIndex,
        humanZIndex: h.zIndex,
      });
    }
  }
  // Elementos que la IA propuso y el humano eliminó.
  for (const ai of aiElements) {
    if (!humanById.has(ai.id)) {
      corrections.push({
        elementId: ai.id,
        kind: ai.kind,
        aiRect: ai.rect,
        humanRect: ai.rect,
        removedByHuman: true,
      });
    }
  }

  // Resumen legible.
  const parts: string[] = [];
  const moved = corrections.filter((c) => !c.addedByHuman && !c.removedByHuman);
  if (moved.length > 0) {
    parts.push(
      `${moved.length} pieza(s) reposicionada(s)/redimensionada(s) respecto a la propuesta de la IA`,
    );
  }
  const added = corrections.filter((c) => c.addedByHuman).length;
  const removed = corrections.filter((c) => c.removedByHuman).length;
  if (added > 0) parts.push(`${added} pieza(s) agregada(s) por el usuario`);
  if (removed > 0) parts.push(`${removed} pieza(s) eliminada(s) por el usuario`);

  return {
    corrections,
    summary: parts.length > 0 ? parts.join('; ') : 'sin cambios significativos',
  };
}
