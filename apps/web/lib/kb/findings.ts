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

// ─── Último informe (para mostrar el "Consejo" en /admin) ────────────────────

const LAST_REPORT_PATH = resolve(HALLAZGOS_DIR, 'last-report.json');

export interface LastAuditReportSintesis {
  resumenEjecutivo: string;
  topHallazgos: Array<{ titulo: string; severidad: string; porQueImporta: string }>;
  proximoPaso: string;
}

export interface LastAuditReport {
  ts: string;
  codeVersion: string;
  depth: string;
  subsistemasAuditados: string[];
  totalHallazgos: number;
  descartados: number;
  sintesis: LastAuditReportSintesis | null;
}

/** Guarda un resumen del último audit (incl. síntesis) para la vista Consejo. */
export async function writeLastAuditReport(r: LastAuditReport): Promise<void> {
  try {
    await mkdir(HALLAZGOS_DIR, { recursive: true });
    await writeFile(LAST_REPORT_PATH, JSON.stringify(r), 'utf-8');
  } catch {
    // best-effort
  }
}

export async function readLastAuditReport(): Promise<LastAuditReport | null> {
  try {
    return JSON.parse(await readFile(LAST_REPORT_PATH, 'utf-8')) as LastAuditReport;
  } catch {
    return null;
  }
}

// ─── Informes del AUDITOR DE FORMATO (scoped por runId/presetId/etiqueta) ─────
// NO pisan last-report.json (el del Consejo global): viven en format-reports/.

const FORMAT_REPORTS_DIR = resolve(HALLAZGOS_DIR, 'format-reports');

export interface FormatAuditReportHallazgo {
  especialista: string;
  severidad: HallazgoSeveridad;
  estado: HallazgoEstado;
  titulo: string;
  descripcion: string;
  fixPropuesto: string;
  confianza: number;
}

export interface FormatAuditReport {
  scope: string; // runId / presetId / etiqueta única del formato auditado
  label: string;
  ts: string;
  codeVersion: string;
  especialistasAuditados: string[];
  totalHallazgos: number;
  descartados: number;
  sintesis: LastAuditReportSintesis | null;
  hallazgos: FormatAuditReportHallazgo[];
}

function safeScopeKey(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'sin-scope';
}

/** Guarda el informe del Auditor de formato (scoped) + actualiza _latest.json. Best-effort. */
export async function writeFormatAuditReport(r: FormatAuditReport): Promise<void> {
  try {
    await mkdir(FORMAT_REPORTS_DIR, { recursive: true });
    const json = JSON.stringify(r);
    await writeFile(resolve(FORMAT_REPORTS_DIR, `${safeScopeKey(r.scope)}.json`), json, 'utf-8');
    await writeFile(resolve(FORMAT_REPORTS_DIR, '_latest.json'), json, 'utf-8');
  } catch {
    // best-effort
  }
}

/** Lee el informe de un scope (o el último auditado si no se pasa scope). */
export async function readFormatAuditReport(scope?: string): Promise<FormatAuditReport | null> {
  try {
    const file = resolve(FORMAT_REPORTS_DIR, scope ? `${safeScopeKey(scope)}.json` : '_latest.json');
    return JSON.parse(await readFile(file, 'utf-8')) as FormatAuditReport;
  } catch {
    return null;
  }
}

// ─── Veredictos de la COMPUERTA DE CALIDAD (video+audio sobre el render) ──────
// La compuerta corre el panel (runFormatAudit) sobre un render YA producido y
// deriva un veredicto DETERMINISTA pass/revisar/fail. Su informe vive aparte de
// los del Auditor de formato: en hallazgos/quality-gates/, scoped por run/path.
// NO pisa _latest.json del Auditor. La persistencia de hallazgos + el reflejo a
// la KB ya los hizo runFormatAudit; aquí solo guardamos el veredicto auditable.

const QUALITY_GATES_DIR = resolve(HALLAZGOS_DIR, 'quality-gates');

export type GateVeredicto = 'pass' | 'revisar' | 'fail';

/** Un hallazgo que justifica el veredicto (espejo legible del Hallazgo subyacente). */
export interface GateBlocker {
  /** Especialista/subsistema que lo emitió (la "dimensión" del formato). */
  dimension: string;
  severidad: HallazgoSeveridad;
  estado: HallazgoEstado;
  titulo: string;
  /** Recomendación accionable. NUNCA se aplica sola (invariante "nada se auto-aplica"). */
  fixPropuesto: string;
  confianza: number;
}

/** Política DETERMINISTA con la que se decidió el veredicto (auditable). */
export interface GatePolicyRecord {
  failOn: 'high' | 'critical';
  reviewOn: 'medium' | 'high';
  reviewOnMediumCount: number;
  countUnverified: boolean;
}

export interface QualityGateReport {
  schemaVersion: 1;
  gateId: string; // 'quality-gate/<fecha>/<uuid8>'
  scope: string; // 'gate:<runId>' o 'gate:<hash-de-path>'
  label: string;
  ts: string;
  codeVersion: string;
  veredicto: GateVeredicto; // DECISIÓN de la compuerta (determinista)
  comparedWithOriginal: boolean;
  resumen: string; // 1-2 frases en español neutro
  bloqueantes: GateBlocker[]; // justifican fail/revisar (ordenados por severidad)
  recomendaciones: GateBlocker[]; // low/medium no bloqueantes (surface-only)
  auditId: string; // ref al FormatAuditResult subyacente
  policy: GatePolicyRecord; // política efectiva usada
  especialistasAuditados: string[];
  especialistasSalteados: string[];
  errores: string[];
}

/** Guarda el veredicto de la compuerta (scoped) + actualiza _latest.json. Best-effort. */
export async function writeQualityGateReport(r: QualityGateReport): Promise<void> {
  try {
    await mkdir(QUALITY_GATES_DIR, { recursive: true });
    const json = JSON.stringify(r);
    await writeFile(resolve(QUALITY_GATES_DIR, `${safeScopeKey(r.scope)}.json`), json, 'utf-8');
    await writeFile(resolve(QUALITY_GATES_DIR, '_latest.json'), json, 'utf-8');
  } catch {
    // best-effort
  }
}

/** Lee el veredicto de un scope (o el último si no se pasa scope). */
export async function readQualityGateReport(scope?: string): Promise<QualityGateReport | null> {
  try {
    const file = resolve(QUALITY_GATES_DIR, scope ? `${safeScopeKey(scope)}.json` : '_latest.json');
    return JSON.parse(await readFile(file, 'utf-8')) as QualityGateReport;
  } catch {
    return null;
  }
}
