// prompt-library.ts — memoria PERSISTENTE de prompts ganadores del Laboratorio.
//
// Cada vez que el bucle APRUEBA una visual, guardamos el prompt que funcionó
// (con su objetivo, score y sub-scores). En el próximo objetivo SIMILAR, se usa
// como SEMILLA del prompt v1 → arranque en caliente: el sistema mejora solo
// entre corridas. Es el cierre del "aprender prompts/formatos de forma
// independiente" que pidió el owner.
//
// Storage: append-only JSONL en storage/promptlab/winning-prompts.jsonl — mismo
// patrón probado que preset-judgment-memory. Cada entrada es un evento con
// timestamp; el agregado/consulta se calcula on-demand. Best-effort: si falla
// el disco, NO bloquea el bucle (la feature es enrichment, no crítica).

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PromptLabMode } from './types';

export interface WinningPromptEntry {
  id: string;
  ts: string; // ISO
  mode: PromptLabMode;
  /** Clave normalizada del objetivo (estilo/intención) para hacer match conservador. */
  targetKey: string;
  brandId?: string;
  prompt: string;
  score: number;
  byDimension: Record<string, number>;
  attempts: number;
  /** Texto legible del objetivo (para la UI). */
  intention?: string;
}

function libraryPath(): string {
  const root = process.env['VF_STORAGE_DIR'] ?? resolve(process.cwd(), 'storage');
  return resolve(root, 'promptlab', 'winning-prompts.jsonl');
}

/** Normaliza un texto a una clave estable: minúsculas, sin acentos, palabras clave. */
export function normalizeTargetKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos (diacríticos combinantes)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 12)
    .sort()
    .join(' ');
}

/** Registra un prompt ganador. Append-only, best-effort (devuelve null si falla). */
export async function recordWinningPrompt(
  entry: Omit<WinningPromptEntry, 'id' | 'ts'>,
  options: { path?: string } = {},
): Promise<string | null> {
  try {
    const path = options.path ?? libraryPath();
    await mkdir(dirname(path), { recursive: true });
    const full: WinningPromptEntry = { ...entry, id: randomUUID(), ts: new Date().toISOString() };
    await appendFile(path, JSON.stringify(full) + '\n', 'utf-8');
    return full.id;
  } catch {
    return null;
  }
}

/** Carga todas las entradas. Array vacío si no existe o está corrupto. */
export async function loadWinningPrompts(
  options: { path?: string } = {},
): Promise<WinningPromptEntry[]> {
  const path = options.path ?? libraryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as WinningPromptEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is WinningPromptEntry => x !== null && typeof x.prompt === 'string');
  } catch {
    return [];
  }
}

/** Solapamiento de palabras entre dos targetKeys (0-1). */
function keyOverlap(a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

export interface QuerySeedArgs {
  mode: PromptLabMode;
  targetKey: string;
  brandId?: string;
  /** Solapamiento mínimo de la clave para considerar "similar". Default 0.5. */
  minOverlap?: number;
}

/**
 * Devuelve el mejor prompt previo para un objetivo SIMILAR (conservador):
 * mismo modo, (misma marca si se pasa), y solapamiento de clave >= minOverlap.
 * Entre los candidatos, gana el de mayor score. null si no hay match.
 */
export async function queryBestSeed(
  args: QuerySeedArgs,
  options: { path?: string } = {},
): Promise<WinningPromptEntry | null> {
  const minOverlap = args.minOverlap ?? 0.5;
  const all = await loadWinningPrompts(options);
  const candidates = all
    .filter((e) => e.mode === args.mode)
    .filter((e) => (args.brandId ? e.brandId === args.brandId : true))
    .filter((e) => keyOverlap(e.targetKey, args.targetKey) >= minOverlap)
    .sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}
