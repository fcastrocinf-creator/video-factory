// Base de Conocimiento — RECEPTOR CENTRAL (buzón). Almacena los eventos del KB
// que cada instalación (empleado) sincroniza vía sync.ts, agrupados por
// instalación. Es la base del dashboard de costo-eficiencia cross-usuario.
//
// Vive en la instalación designada como "central" (la del owner, o un deploy
// dedicado). Best-effort en escritura; nunca expone secretos.

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KB_DIR, type KbEvento } from './record';

const CENTRAL_DIR = resolve(KB_DIR, 'central');

/** Evento recibido, con la instalación de origen + cuándo llegó (trazabilidad). */
export type CentralEvento = KbEvento & { _instalacion: string; _recibidoEn: string };

/** Sanitiza el nombre de la instalación para usarlo como nombre de archivo. */
function safeName(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  return clean.length > 0 ? clean : 'unknown';
}

/**
 * Almacena los eventos recibidos de una instalación (un archivo JSONL por
 * instalación). Devuelve cuántos guardó. Best-effort.
 */
export async function ingestEventos(
  instalacion: string,
  eventos: KbEvento[],
  recibidoEn: string,
): Promise<number> {
  if (!Array.isArray(eventos) || eventos.length === 0) return 0;
  await mkdir(CENTRAL_DIR, { recursive: true });
  const file = resolve(CENTRAL_DIR, `${safeName(instalacion)}.jsonl`);
  const lines =
    eventos
      .map((e) => JSON.stringify({ ...e, _instalacion: instalacion, _recibidoEn: recibidoEn }))
      .join('\n') + '\n';
  await appendFile(file, lines, 'utf-8');
  return eventos.length;
}

/** Lee todos los eventos recibidos de todas las instalaciones. Best-effort. */
export async function readCentralEventos(): Promise<CentralEvento[]> {
  let files: string[];
  try {
    files = (await readdir(CENTRAL_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return []; // el dir aún no existe (nadie sincronizó todavía)
  }
  const out: CentralEvento[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(resolve(CENTRAL_DIR, f), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as CentralEvento);
      } catch {
        // skip línea corrupta
      }
    }
  }
  return out;
}

/** Extrae costUsd del bloque ```json``` del contenido de un run-evento. null si no hay. */
function parseCostUsd(contenido: string): number | null {
  const m = contenido.match(/```json\s*([\s\S]*?)```/);
  if (!m || !m[1]) return null;
  try {
    const d = JSON.parse(m[1].trim()) as { costUsd?: unknown };
    return typeof d.costUsd === 'number' && Number.isFinite(d.costUsd) ? d.costUsd : null;
  } catch {
    return null;
  }
}

export interface InstallCostStat {
  instalacion: string;
  videos: number;
  gastoTotalUsd: number;
  costoPromedioUsd: number;
  ultimoTs: string | null;
}

/**
 * Agrega el gasto por instalación desde los eventos recibidos. Cuenta como
 * "video" cada run completado (fuente `system-log:run-completed`) y suma su
 * costUsd. Orden: menor costo-promedio primero (= más costo-eficiente).
 *
 * NOTA: el costo es un ESTIMADO del pipeline (subcuenta los clips de video).
 * Sirve para COMPARAR entre instalaciones, no como cifra exacta al centavo.
 */
export async function centralCostStats(): Promise<InstallCostStat[]> {
  const all = await readCentralEventos();
  const by = new Map<string, { videos: number; gasto: number; ultimoTs: string | null }>();
  for (const e of all) {
    if (e.tipo !== 'run-evento' || e.fuente !== 'system-log:run-completed') continue;
    const cost = parseCostUsd(e.contenido) ?? 0;
    const cur = by.get(e._instalacion) ?? { videos: 0, gasto: 0, ultimoTs: null };
    cur.videos += 1;
    cur.gasto += cost;
    if (!cur.ultimoTs || e.ts > cur.ultimoTs) cur.ultimoTs = e.ts;
    by.set(e._instalacion, cur);
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const out: InstallCostStat[] = [];
  for (const [instalacion, s] of by) {
    out.push({
      instalacion,
      videos: s.videos,
      gastoTotalUsd: round(s.gasto),
      costoPromedioUsd: s.videos > 0 ? round(s.gasto / s.videos) : 0,
      ultimoTs: s.ultimoTs,
    });
  }
  out.sort((a, b) => a.costoPromedioUsd - b.costoPromedioUsd);
  return out;
}
