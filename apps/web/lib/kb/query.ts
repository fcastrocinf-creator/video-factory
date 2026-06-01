// Base de Conocimiento — Fase 1: CONSULTA / UBICACIÓN ("saber dónde está").
// Lee los `Evento` que recolecta record.ts (Fase 0) y arma: (a) consultas
// filtradas, (b) agregados para la vista /admin, (c) un contexto CHICO y
// pre-digerido para un agente — NO dumps crudos (ese pre-digerido es el ahorro
// de la KB, ver CONOCIMIENTO.md §5/§8). Cero IA, solo lectura + filtrado.
// Best-effort: nunca lanza.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  EVENTOS_DIR,
  type KbEvento,
  type KbSubsistema,
  type KbTipo,
  type KbEntidad,
} from './record';

export interface QueryFilters {
  vault?: 'dev' | 'producto';
  subsistema?: KbSubsistema;
  tipo?: KbTipo;
  /** Match por cualquier campo provisto de la entidad (AND). */
  entidad?: Partial<KbEntidad>;
  tag?: string;
  estado?: KbEvento['estado'];
  /** ISO inclusive (ts >= desde). */
  desde?: string;
  /** ISO inclusive (ts <= hasta). */
  hasta?: string;
  /** Límite de resultados (más recientes primero). Sin límite si se omite. */
  limit?: number;
}

/**
 * Lee y parsea los eventos. Si se pasa `soloSubsistema`, lee solo ese archivo
 * (los eventos están particionados por subsistema → lectura barata y dirigida).
 */
async function readAllEventos(soloSubsistema?: KbSubsistema): Promise<KbEvento[]> {
  const out: KbEvento[] = [];
  let files: string[];
  try {
    if (soloSubsistema) {
      files = [`${soloSubsistema}.jsonl`];
    } else {
      files = (await readdir(EVENTOS_DIR)).filter((f) => f.endsWith('.jsonl'));
    }
  } catch {
    return out; // el dir aún no existe (KB vacía)
  }
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(resolve(EVENTOS_DIR, f), 'utf-8');
    } catch {
      continue; // archivo inexistente/ilegible
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as KbEvento);
      } catch {
        // skip línea corrupta
      }
    }
  }
  return out;
}

function matchesEntidad(ev: KbEvento, want?: Partial<KbEntidad>): boolean {
  if (!want) return true;
  const have = (ev.entidad ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined || v === null) continue;
    if (have[k] !== v) return false;
  }
  return true;
}

/** Consulta eventos por filtros. Devuelve los más recientes primero. Best-effort. */
export async function query(f: QueryFilters = {}): Promise<KbEvento[]> {
  const all = await readAllEventos(f.subsistema);
  const filtered = all.filter((ev) => {
    if (f.vault && ev.vault !== f.vault) return false;
    if (f.tipo && ev.tipo !== f.tipo) return false;
    if (f.estado && ev.estado !== f.estado) return false;
    if (f.tag && !(ev.tags ?? []).includes(f.tag)) return false;
    if (f.desde && ev.ts < f.desde) return false;
    if (f.hasta && ev.ts > f.hasta) return false;
    if (!matchesEntidad(ev, f.entidad)) return false;
    return true;
  });
  // ts desc (ISO 8601 ordena lexicográficamente).
  filtered.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return typeof f.limit === 'number' ? filtered.slice(0, f.limit) : filtered;
}

export interface KbStats {
  total: number;
  porVault: Record<string, number>;
  porSubsistema: Record<string, number>;
  porTipo: Record<string, number>;
  ultimoTs: string | null;
  codeVersion: string | null;
}

/** Agregados rápidos para la vista /admin. Best-effort. */
export async function kbStats(): Promise<KbStats> {
  const all = await readAllEventos();
  const stats: KbStats = {
    total: all.length,
    porVault: {},
    porSubsistema: {},
    porTipo: {},
    ultimoTs: null,
    codeVersion: null,
  };
  for (const ev of all) {
    stats.porVault[ev.vault] = (stats.porVault[ev.vault] ?? 0) + 1;
    stats.porSubsistema[ev.subsistema] = (stats.porSubsistema[ev.subsistema] ?? 0) + 1;
    stats.porTipo[ev.tipo] = (stats.porTipo[ev.tipo] ?? 0) + 1;
    if (!stats.ultimoTs || ev.ts > stats.ultimoTs) {
      stats.ultimoTs = ev.ts;
      stats.codeVersion = ev.codeVersion ?? stats.codeVersion;
    }
  }
  return stats;
}

export interface ContextScope {
  subsistema?: KbSubsistema;
  tipo?: KbTipo;
  entidad?: Partial<KbEntidad>;
  vault?: 'dev' | 'producto';
}

/**
 * Arma un contexto CHICO y preciso (markdown) para inyectar a un agente — NO un
 * dump crudo. Toma los eventos más relevantes del scope, los resume en una línea
 * cada uno y trunca a `maxChars`. Este pre-digerido es el ahorro de la KB:
 * cada agente razona con lo justo, sin leer todo. (CONOCIMIENTO.md §5/§8.)
 */
export async function buildContextFor(scope: ContextScope = {}, maxChars = 4000): Promise<string> {
  const eventos = await query({
    subsistema: scope.subsistema,
    tipo: scope.tipo,
    entidad: scope.entidad,
    vault: scope.vault,
    limit: 80,
  });
  if (eventos.length === 0) return '(KB: sin eventos para este scope)';

  const header = scopeHeader(scope);
  const lines: string[] = [header];
  let total = header.length;
  let shown = 0;
  for (const ev of eventos) {
    const line = formatEventoLine(ev);
    if (total + line.length + 1 > maxChars) {
      lines.push(`… (+${eventos.length - shown} eventos más, truncado por tamaño)`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
    shown += 1;
  }
  return lines.join('\n');
}

function scopeHeader(scope: ContextScope): string {
  const parts: string[] = [];
  if (scope.vault) parts.push(`vault=${scope.vault}`);
  if (scope.subsistema) parts.push(`subsistema=${scope.subsistema}`);
  if (scope.tipo) parts.push(`tipo=${scope.tipo}`);
  if (scope.entidad) {
    for (const [k, v] of Object.entries(scope.entidad)) {
      if (v !== undefined && v !== null) parts.push(`${k}=${v}`);
    }
  }
  return `## KB context${parts.length ? ` (${parts.join(', ')})` : ''} — más recientes primero`;
}

function formatEventoLine(ev: KbEvento): string {
  const ts = ev.ts.slice(0, 16).replace('T', ' ');
  const sev = ev.severidad && ev.severidad !== 'info' ? ` [${ev.severidad}]` : '';
  const estado = ev.estado ? ` {${ev.estado}}` : '';
  const ent = entidadResumen(ev.entidad ?? {});
  return `- [${ts}] ${ev.subsistema}/${ev.tipo}${sev}${estado} — ${ev.titulo}${ent}`;
}

function entidadResumen(en: KbEntidad): string {
  const parts: string[] = [];
  if (en.runId) parts.push(`run:${en.runId.slice(0, 8)}`);
  if (en.presetId) parts.push(`preset:${en.presetId}`);
  if (en.brandId) parts.push(`brand:${en.brandId}`);
  if (typeof en.sceneIndex === 'number') parts.push(`scene:${en.sceneIndex}`);
  if (en.userId) parts.push(`user:${en.userId}`);
  return parts.length ? ` (${parts.join(' ')})` : '';
}
