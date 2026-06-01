// Base de Conocimiento — persistencia de HALLAZGOS de auditoría + su desenlace
// (el "bucle de resultado", CONOCIMIENTO.md §6.5/§7). Append-only JSONL en
// storage/kb/hallazgos/findings.jsonl. Best-effort: nunca lanza.
//
// Además guarda un caché `last-audit.json` (codeVersion+ts por subsistema) para
// que deepAudit pueda SALTAR subsistemas sin cambios — el ahorro de la KB (§8).

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KB_DIR } from './record';

const HALLAZGOS_DIR = resolve(KB_DIR, 'hallazgos');
const FINDINGS_PATH = resolve(HALLAZGOS_DIR, 'findings.jsonl');
const LAST_AUDIT_PATH = resolve(HALLAZGOS_DIR, 'last-audit.json');

export type HallazgoEstado =
  | 'abierto'
  | 'confirmado'
  | 'falso-positivo'
  | 'arreglado'
  | 'descartado';
export type HallazgoSeveridad = 'low' | 'medium' | 'high' | 'critical';

export interface Hallazgo {
  id: string;
  auditId: string;
  ts: string;
  codeVersion: string;
  subsistema: string;
  severidad: HallazgoSeveridad;
  estado: HallazgoEstado;
  titulo: string;
  descripcion: string;
  evidencia: string;
  fixPropuesto: string;
  confianza: number;
  verificacion?: { veredicto: string; razon: string };
}

export type RecordHallazgoInput = Omit<Hallazgo, 'id' | 'ts'> & {
  id?: string;
  ts?: string;
};

/** Persiste un hallazgo (append-only). Best-effort. Devuelve el registro completo. */
export async function recordHallazgo(input: RecordHallazgoInput): Promise<Hallazgo> {
  const ts = input.ts ?? new Date().toISOString();
  const full: Hallazgo = {
    id: input.id ?? `hallazgo/${ts.slice(0, 10)}/${randomUUID().slice(0, 8)}`,
    ts,
    auditId: input.auditId,
    codeVersion: input.codeVersion,
    subsistema: input.subsistema,
    severidad: input.severidad,
    estado: input.estado,
    titulo: input.titulo,
    descripcion: input.descripcion,
    evidencia: input.evidencia,
    fixPropuesto: input.fixPropuesto,
    confianza: input.confianza,
    verificacion: input.verificacion,
  };
  try {
    await mkdir(HALLAZGOS_DIR, { recursive: true });
    await appendFile(FINDINGS_PATH, JSON.stringify(full) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
  return full;
}

export interface ListHallazgosFilters {
  subsistema?: string;
  estado?: HallazgoEstado;
  auditId?: string;
  limit?: number;
}

/**
 * Lista hallazgos. Si un id aparece varias veces (actualizaciones de estado vía
 * append), se queda con la ÚLTIMA ocurrencia. Más recientes primero. Best-effort.
 */
export async function listHallazgos(filtros: ListHallazgosFilters = {}): Promise<Hallazgo[]> {
  let raw: string;
  try {
    raw = await readFile(FINDINGS_PATH, 'utf-8');
  } catch {
    return [];
  }
  const byId = new Map<string, Hallazgo>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const h = JSON.parse(t) as Hallazgo;
      byId.set(h.id, h); // la última ocurrencia gana
    } catch {
      // skip línea corrupta
    }
  }
  let result = [...byId.values()];
  if (filtros.subsistema) result = result.filter((h) => h.subsistema === filtros.subsistema);
  if (filtros.estado) result = result.filter((h) => h.estado === filtros.estado);
  if (filtros.auditId) result = result.filter((h) => h.auditId === filtros.auditId);
  result.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return typeof filtros.limit === 'number' ? result.slice(0, filtros.limit) : result;
}

/**
 * Actualiza el estado de un hallazgo (bucle de resultado, Fase 3). Append-only:
 * escribe una línea nueva con el mismo id y el estado nuevo; listHallazgos se
 * queda con la última. Devuelve false si el id no existe.
 */
export async function updateHallazgoEstado(
  id: string,
  estado: HallazgoEstado,
): Promise<boolean> {
  const all = await listHallazgos();
  const found = all.find((h) => h.id === id);
  if (!found) return false;
  await recordHallazgo({ ...found, estado });
  return true;
}

// ─── Caché de último audit por subsistema (ahorro: saltar lo no cambiado) ────

export type LastAuditMap = Record<string, { codeVersion: string; ts: string }>;

export async function readLastAudit(): Promise<LastAuditMap> {
  try {
    return JSON.parse(await readFile(LAST_AUDIT_PATH, 'utf-8')) as LastAuditMap;
  } catch {
    return {};
  }
}

export async function writeLastAudit(map: LastAuditMap): Promise<void> {
  try {
    await mkdir(HALLAZGOS_DIR, { recursive: true });
    await writeFile(LAST_AUDIT_PATH, JSON.stringify(map), 'utf-8');
  } catch {
    // best-effort
  }
}
