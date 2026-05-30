// preset-judgment-memory.ts — Feedback loop de aprobación humana de presets.
//
// Cada vez que el owner aprueba un preset en /admin (o lo rechaza, edita,
// o lo usa exitosamente), registramos un "juicio" con peso. Con el tiempo,
// el cerebro acumula datos reales de QUÉ FUNCIONA EN PRODUCCIÓN y puede:
//   - Recomendar presets con mayor weight al usuario en /create
//   - Detectar patrones (ej: presets con format='ugc-testimony' tienen 90% aprobación)
//   - Sugerir refinamientos al promptTemplate de presets con baja aprobación
//   - El validator chat IA inyecta este conocimiento como context histórico
//
// Storage: append-only JSONL en storage/preset-memory/judgments.jsonl, mismo
// enfoque que error-memory y composition-memory. Cada juicio es un evento
// independiente con timestamp — el agregado se calcula on-demand.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type JudgmentKind =
  | 'approved' // owner aprobó el preset en /admin
  | 'rejected' // owner rechazó (descartó o borró)
  | 'edited' // owner editó manualmente el promptTemplate después de auto-learn
  | 'run-success' // un run con este preset terminó sin issues críticos en M5
  | 'run-failed' // un run con este preset falló o tuvo critical issues
  | 'used-for-rip' // el preset se usó en un rip (señal de uso, no de calidad)
  | 'other';

export interface PresetJudgmentEntry {
  id: string;
  judgedAt: string; // ISO timestamp
  presetId: string;
  kind: JudgmentKind;
  /** Peso del juicio. Default 1.0. Aprobaciones tras 0 ediciones manuales = 1.5, etc. */
  weight: number;
  /** Contexto: brand, run, score, lo que sea útil para análisis */
  context?: Record<string, unknown>;
  /** Notas legibles para humanos */
  notes?: string;
}

function defaultJudgmentMemoryPath(): string {
  return resolve(process.cwd(), 'storage', 'preset-memory', 'judgments.jsonl');
}

/**
 * Registra un juicio sobre un preset. Append-only. Best-effort — si falla
 * (disco lleno, permission denied), devuelve null y NO debe bloquear el flujo
 * caller (la feature es enrichment, no crítica).
 */
export async function recordPresetJudgment(
  entry: Omit<PresetJudgmentEntry, 'id' | 'judgedAt'>,
  options: { path?: string } = {},
): Promise<string | null> {
  try {
    const path = options.path ?? defaultJudgmentMemoryPath();
    await mkdir(dirname(path), { recursive: true });
    const full: PresetJudgmentEntry = {
      ...entry,
      id: randomUUID(),
      judgedAt: new Date().toISOString(),
    };
    await appendFile(path, JSON.stringify(full) + '\n', 'utf-8');
    return full.id;
  } catch {
    // best-effort
    return null;
  }
}

/**
 * Carga todos los juicios persistidos. Retorna array vacío si no existe.
 */
export async function loadAllPresetJudgments(
  options: { path?: string } = {},
): Promise<PresetJudgmentEntry[]> {
  const path = options.path ?? defaultJudgmentMemoryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as PresetJudgmentEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is PresetJudgmentEntry => x !== null);
  } catch {
    return [];
  }
}

export interface PresetScore {
  presetId: string;
  /** Confianza acumulada (suma de weights de aprobaciones — rechazos) */
  confidence: number;
  /** Cantidad total de juicios sobre este preset */
  totalJudgments: number;
  judgmentCounts: Record<JudgmentKind, number>;
  /** ISO del juicio más reciente */
  lastJudgedAt?: string;
}

/**
 * Agrega los juicios por preset. Calcula un score de confianza basado en:
 *   - approved/run-success → +weight
 *   - rejected/run-failed → -weight
 *   - edited → +0.3 * weight (uso parcial — el owner modificó pero no descartó)
 *   - used-for-rip → +0.1 * weight (señal débil de uso real)
 */
export async function getPresetConfidenceScores(
  options: { path?: string } = {},
): Promise<PresetScore[]> {
  const all = await loadAllPresetJudgments(options);
  const byPreset = new Map<string, PresetScore>();

  const VALID_KINDS: Set<JudgmentKind> = new Set([
    'approved',
    'rejected',
    'edited',
    'run-success',
    'run-failed',
    'used-for-rip',
    'other',
  ]);

  for (const j of all) {
    // DEFENSIVE: validar campos críticos antes de usarlos. El JSONL puede tener
    // entries de versiones viejas con campos faltantes / mal tipados. NUNCA queremos
    // que un solo entry corrupto convierta TODO el ranking en NaN.
    if (!j.presetId || typeof j.presetId !== 'string') continue;
    if (!VALID_KINDS.has(j.kind)) continue; // kinds desconocidos se ignoran
    const w =
      typeof j.weight === 'number' && Number.isFinite(j.weight) && j.weight >= 0
        ? j.weight
        : 1.0; // default si weight inválido o ausente

    let score = byPreset.get(j.presetId);
    if (!score) {
      score = {
        presetId: j.presetId,
        confidence: 0,
        totalJudgments: 0,
        judgmentCounts: {
          approved: 0,
          rejected: 0,
          edited: 0,
          'run-success': 0,
          'run-failed': 0,
          'used-for-rip': 0,
          other: 0,
        },
      };
      byPreset.set(j.presetId, score);
    }
    score.totalJudgments += 1;
    score.judgmentCounts[j.kind] += 1;
    switch (j.kind) {
      case 'approved':
      case 'run-success':
        score.confidence += w;
        break;
      case 'rejected':
      case 'run-failed':
        score.confidence -= w;
        break;
      case 'edited':
        score.confidence += 0.3 * w;
        break;
      case 'used-for-rip':
        score.confidence += 0.1 * w;
        break;
      default:
        break;
    }
    if (j.judgedAt && (!score.lastJudgedAt || j.judgedAt > score.lastJudgedAt)) {
      score.lastJudgedAt = j.judgedAt;
    }
  }

  return [...byPreset.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * Bloque de texto resumen para inyectar en system-context o en prompts.
 * Top-N presets con scores. Vacío si no hay juicios.
 */
export function formatPresetConfidenceForContext(scores: PresetScore[], topN: number = 10): string {
  if (scores.length === 0) return '';
  const top = scores.slice(0, topN);
  const lines = top.map(
    (s) =>
      `  - ${s.presetId}: confidence=${s.confidence.toFixed(1)} (${s.totalJudgments} judgments: ` +
      `${s.judgmentCounts.approved}✓ ${s.judgmentCounts.rejected}✗ ${s.judgmentCounts.edited}✎ ` +
      `${s.judgmentCounts['run-success']}🟢 ${s.judgmentCounts['run-failed']}🔴)`,
  );
  return `\n\nPRESET CONFIDENCE (de juicios históricos del owner, mayor=mejor):\n${lines.join('\n')}`;
}
