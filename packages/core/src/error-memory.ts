// Error Memory: knowledge base persistido de errores conocidos de generación.
//
// Filosofía: cada vez que el validator detecta un error específico en una escena
// (ej. "ojeras = rayas rojas como sangre" en Higgsfield), registramos:
//   - qué provider/modelo lo produjo
//   - qué pidió el prompt original
//   - qué error se observó
//   - qué hint sugirió el validator
//   - si después de retry funcionó (closure loop)
//
// En cada run nuevo, scene-planner consulta esta KB ANTES de generar prompts y
// recibe "AVOID PATTERNS LEARNED FROM PAST FAILURES" en su system prompt. Con el
// tiempo, los prompts evitan los pitfalls específicos de cada modelo.
//
// Storage: append-only JSONL en storage/error-memory/errors.jsonl. Cada línea
// es una entrada JSON. Sin SQLite por simplicidad — esto rara vez supera 10K
// entradas y queries son keyword-match in memory.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ErrorCategory =
  | 'anatomy_hands' // 4 dedos, dedos fusionados, etc.
  | 'anatomy_feet' // pies mal contados o desproporcionados
  | 'anatomy_face' // tercer ojo, simetría rota
  | 'body_proportions' // pies más grandes que cabeza, etc.
  | 'body_part_fusion' // partes del cuerpo que se mezclan
  | 'text_gibberish' // labels/text random
  | 'numbers_illogical' // calendarios rotos
  | 'illogical_element' // elementos abstractos cuando se piden cosas reales (ojeras=infinity loops, marcas=sangre)
  | 'semantic_mismatch' // imagen no representa la narración
  | 'character_mismatch' // narrador con gender/edad/etnia errónea
  | 'style_break' // sale de la paleta del preset
  | 'safety_filter' // safety block del provider
  | 'other';

export interface ErrorMemoryEntry {
  id: string;
  detectedAt: string; // ISO timestamp
  // Contexto
  provider: string; // "google-imagen" | "higgsfield" | "fal-ai" | "vertex-imagen"
  model: string; // ej. "imagen-4.0-fast-generate-001" o "flux-pro/kontext/max/text-to-image"
  brand?: string;
  preset?: string;
  runId?: string;
  // Qué se intentó
  narration: string; // texto narrado
  originalPrompt: string;
  // Qué falló
  errorCategory: ErrorCategory;
  errorDescription: string; // descripción humana del problema observado
  validatorScore?: number; // 0-100
  refinementHintGiven?: string; // hint que el validator generó
  // Resultado del fix (set después de retry)
  wasFixed?: boolean; // true si retry pasó el validator
  // Tags para búsqueda rápida
  keywords: string[]; // ej: ['ojeras', 'dark-circles', 'red-streaks']
}

/** Path al archivo de memoria. Override para tests. */
function defaultErrorMemoryPath(): string {
  // El proceso corre desde el cwd del proyecto. Resolvemos relativo a cwd.
  return resolve(process.cwd(), 'storage', 'error-memory', 'errors.jsonl');
}

/**
 * Registra un error en la memoria. Append-only — no muta entradas existentes.
 * Si el archivo no existe, lo crea con su carpeta padre.
 *
 * Devuelve el id generado para que el caller pueda hacer updateMemoryFix() si
 * el retry funciona (cerrar el loop de feedback).
 */
export async function recordError(
  entry: Omit<ErrorMemoryEntry, 'id' | 'detectedAt'>,
  options: { path?: string } = {},
): Promise<string> {
  const path = options.path ?? defaultErrorMemoryPath();
  await mkdir(dirname(path), { recursive: true });
  const full: ErrorMemoryEntry = {
    ...entry,
    id: randomUUID(),
    detectedAt: new Date().toISOString(),
  };
  await appendFile(path, JSON.stringify(full) + '\n', 'utf-8');
  return full.id;
}

/**
 * Carga TODAS las entradas del archivo. Para queries pequeñas/medianas (<10K)
 * está bien tener todo en memoria. Si crece más, migrar a SQLite.
 */
export async function loadAllErrors(
  options: { path?: string } = {},
): Promise<ErrorMemoryEntry[]> {
  const path = options.path ?? defaultErrorMemoryPath();
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as ErrorMemoryEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is ErrorMemoryEntry => x !== null);
}

/**
 * Encuentra errores relevantes para un contexto dado. Usa matching simple por
 * keywords + provider + categoría. Devuelve los top-K más relevantes.
 *
 * Estrategia de scoring:
 * - +5 si match exacto en keyword
 * - +3 si match en errorCategory
 * - +2 si mismo provider
 * - +1 si misma narración (substring)
 * - bonus +2 si wasFixed=true (queremos APRENDER de los fixes que funcionaron)
 */
export async function queryRelevantErrors(opts: {
  narration?: string;
  keywords?: string[];
  provider?: string;
  category?: ErrorCategory;
  topK?: number;
  onlyFixed?: boolean; // solo errores con fix exitoso conocido
  path?: string;
}): Promise<ErrorMemoryEntry[]> {
  const all = await loadAllErrors({ path: opts.path });
  if (all.length === 0) return [];
  const k = opts.topK ?? 10;
  const queryKeywords = (opts.keywords ?? []).map((k) => k.toLowerCase());
  const narrationLc = (opts.narration ?? '').toLowerCase();

  const scored = all
    .filter((e) => !opts.onlyFixed || e.wasFixed === true)
    .map((e) => {
      let score = 0;
      const entryKwLc = e.keywords.map((k) => k.toLowerCase());
      for (const kw of queryKeywords) {
        if (entryKwLc.includes(kw)) score += 5;
      }
      if (opts.category && e.errorCategory === opts.category) score += 3;
      if (opts.provider && e.provider === opts.provider) score += 2;
      if (narrationLc && e.narration.toLowerCase().includes(narrationLc.slice(0, 40))) score += 1;
      if (e.wasFixed === true) score += 2;
      return { e, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ e }) => e);

  return scored;
}

/**
 * Marca una entrada como "fix funcionó" cuando el retry pasa el validator.
 * Re-escribe el archivo entero (append-only se rompe pero la KB es pequeña).
 */
export async function markErrorFixed(
  id: string,
  options: { path?: string } = {},
): Promise<void> {
  const path = options.path ?? defaultErrorMemoryPath();
  const all = await loadAllErrors({ path });
  const updated = all.map((e) => (e.id === id ? { ...e, wasFixed: true } : e));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, updated.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

/**
 * Construye un bloque de texto para inyectar en el system prompt de scene-planner
 * con las "lecciones aprendidas". Devuelve string vacío si no hay errores
 * relevantes. Optimizado para no inflar tokens en exceso (top 10 fixes
 * accionables, no toda la KB).
 */
export function formatLessonsLearned(errors: ErrorMemoryEntry[]): string {
  if (errors.length === 0) return '';
  const lessons = errors.slice(0, 10).map((e, i) => {
    const fixNote = e.wasFixed
      ? ` FIX QUE FUNCIONÓ: "${e.refinementHintGiven?.slice(0, 200) ?? 'sin hint'}"`
      : '';
    return `${i + 1}. [${e.errorCategory}] Con ${e.provider}, prompt "${e.originalPrompt.slice(0, 80)}..." → produjo: ${e.errorDescription.slice(0, 200)}.${fixNote}`;
  });
  return `\n\nLESSONS LEARNED FROM PAST FAILURES (avoid these patterns):\n${lessons.join('\n')}\n\nWhen generating prompts, actively AVOID the patterns above. Use the fix techniques that worked.`;
}
