// Base de Conocimiento — Fase 0: RECOLECCIÓN (automática, cero IA, barata).
// Ver CONOCIMIENTO.md. Una sola función `recordEvent` por la que pasan todos los
// emisores (chat, runs, juicios, sugerencias, feedback, hallazgos). Append-only
// JSONL en storage/kb/ + un índice para "ubicar". Best-effort: NUNCA rompe el flujo.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { STORAGE_DIR } from '../paths';

export const KB_DIR = resolve(STORAGE_DIR, 'kb');
export const EVENTOS_DIR = resolve(KB_DIR, 'eventos');
export const INDICE_DIR = resolve(KB_DIR, 'indice');

export type KbSubsistema =
  | 'pipeline' | 'validator' | 'chat' | 'aprendizaje' | 'compositor'
  | 'seguridad' | 'ux' | 'image-gen' | 'animacion' | 'otro';

export type KbTipo =
  | 'bug' | 'hallazgo-auditoria' | 'feedback' | 'decision' | 'metrica'
  | 'juicio-preset' | 'sugerencia' | 'chat' | 'run-evento';

export interface KbEntidad {
  brandId?: string;
  presetId?: string;
  runId?: string;
  sceneIndex?: number;
  userId?: string;
}

export interface KbEvento {
  id: string;
  ts: string;
  codeVersion: string;
  vault: 'dev' | 'producto';
  subsistema: KbSubsistema;
  tipo: KbTipo;
  entidad: KbEntidad;
  severidad?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  estado?: 'abierto' | 'confirmado' | 'falso-positivo' | 'arreglado' | 'descartado';
  titulo: string;
  contenido: string;
  enlaces: string[];
  fuente: string;
  confianza?: number;
  tags: string[];
}

export type RecordInput = Omit<KbEvento, 'id' | 'ts' | 'codeVersion' | 'enlaces' | 'tags'> & {
  enlaces?: string[];
  tags?: string[];
};

// codeVersion (commit corto) para FRESCURA. Se calcula una vez y se cachea.
let _codeVersion: string | null = null;
function codeVersion(): string {
  if (_codeVersion !== null) return _codeVersion;
  try {
    _codeVersion =
      execSync('git rev-parse --short HEAD', {
        cwd: STORAGE_DIR,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || 'unknown';
  } catch {
    _codeVersion = 'unknown';
  }
  return _codeVersion;
}

/** Versión del código (git short hash) cacheada — para frescura y caché de auditoría. */
export function getCodeVersion(): string {
  return codeVersion();
}

/** Registra un evento en la base de conocimiento. Best-effort, sin IA. */
export async function recordEvent(input: RecordInput): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const id = `${input.tipo}/${ts.slice(0, 10)}/${randomUUID().slice(0, 8)}`;
    const evento: KbEvento = {
      id,
      ts,
      codeVersion: codeVersion(),
      vault: input.vault,
      subsistema: input.subsistema,
      tipo: input.tipo,
      entidad: input.entidad ?? {},
      severidad: input.severidad,
      estado: input.estado,
      titulo: input.titulo,
      contenido: input.contenido,
      enlaces: input.enlaces ?? [],
      fuente: input.fuente,
      confianza: input.confianza,
      tags: input.tags ?? [],
    };
    await mkdir(EVENTOS_DIR, { recursive: true });
    await appendFile(
      resolve(EVENTOS_DIR, `${evento.subsistema}.jsonl`),
      `${JSON.stringify(evento)}\n`,
      'utf-8',
    );
    await updateIndex(evento);
  } catch {
    // best-effort: la recolección NUNCA debe interrumpir el flujo principal.
  }
}

// Índice "por entidad/subsistema/tipo" para poder UBICAR eventos rápido sin leer todo.
async function updateIndex(e: KbEvento): Promise<void> {
  try {
    await mkdir(INDICE_DIR, { recursive: true });
    const path = resolve(INDICE_DIR, 'por-entidad.json');
    let idx: Record<string, string[]> = {};
    try {
      idx = JSON.parse(await readFile(path, 'utf-8')) as Record<string, string[]>;
    } catch {
      idx = {};
    }
    const keys: string[] = [`subsistema:${e.subsistema}`, `tipo:${e.tipo}`, `vault:${e.vault}`];
    const en = e.entidad;
    if (en.brandId) keys.push(`brand:${en.brandId}`);
    if (en.presetId) keys.push(`preset:${en.presetId}`);
    if (en.runId) keys.push(`run:${en.runId}`);
    if (en.userId) keys.push(`user:${en.userId}`);
    for (const k of keys) {
      (idx[k] ??= []).push(e.id);
    }
    await writeFile(path, JSON.stringify(idx), 'utf-8');
  } catch {
    // best-effort
  }
}
