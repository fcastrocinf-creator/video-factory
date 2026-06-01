// system-log.ts — M9 Pieza 2: registro automático de eventos del sistema.
//
// Cada evento significativo (run started, preset created, editor IA action,
// sugerencia posteada, scene regenerada) se persiste como una línea JSON al
// archivo storage/system-log.jsonl. Append-only para no perder historial.
//
// El log es leído por buildSystemContext() para informar al chat IA Claude
// sobre lo que ha pasado recientemente — así Claude sabe el estado actual
// del proyecto sin que el caller tenga que hardcodear contexto en cada prompt.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const SYSTEM_LOG_PATH = (() => {
  // Storage unificado: VF_STORAGE_DIR (next.config) = <root>/storage para todos.
  const unified = process.env['VF_STORAGE_DIR'];
  if (unified) return resolve(unified, 'system-log.jsonl');
  // Fallback (scripts sin next.config): buscar la raíz del repo.
  const candidates = [
    resolve(process.cwd(), 'storage', 'system-log.jsonl'),
    resolve(process.cwd(), '..', '..', 'storage', 'system-log.jsonl'),
  ];
  for (const c of candidates) {
    const parent = dirname(c);
    if (existsSync(parent)) return c;
  }
  return candidates[0]!;
})();

export type SystemEventKind =
  | 'run-started'
  | 'run-completed'
  | 'run-failed'
  | 'preset-created'
  | 'preset-approved'
  | 'editor-ia-action'
  | 'editor-ia-verdict'
  | 'suggestion-posted'
  | 'scene-regenerated'
  | 'auto-learn-invoked'
  | 'chat-discuss-message'
  | 'video-understood'
  | 'config-changed'
  | 'other';

export interface SystemEvent {
  ts: string; // ISO 8601
  kind: SystemEventKind;
  // Datos arbitrarios — keep small (~500 chars max idealmente)
  data: Record<string, unknown>;
  // Notas legibles para humanos (opcional, lo que Claude ve en el context)
  summary?: string;
}

/**
 * Registra un evento al system log. NUNCA throw — si el log falla, NO
 * debe bloquear el flujo principal.
 *
 * Append-only — preserva todo el historial.
 */
export async function logSystemEvent(
  event: Omit<SystemEvent, 'ts'>,
): Promise<void> {
  try {
    const dir = dirname(SYSTEM_LOG_PATH);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const fullEvent: SystemEvent = {
      ts: new Date().toISOString(),
      ...event,
    };
    await appendFile(SYSTEM_LOG_PATH, JSON.stringify(fullEvent) + '\n', 'utf-8');
  } catch {
    // Silent fail — no queremos que un error de log rompa el pipeline.
    // El próximo evento que SÍ logre persistir capturará el contexto.
  }
}

/**
 * Lee los últimos N eventos del system log. Devuelve [] si el archivo
 * no existe (caso fresh install).
 *
 * @param limit Cuántos eventos devolver. Default 20.
 * @param kinds Si se pasa, filtrar por estos tipos
 */
export async function readRecentEvents(
  limit = 20,
  kinds?: SystemEventKind[],
): Promise<SystemEvent[]> {
  try {
    if (!existsSync(SYSTEM_LOG_PATH)) return [];
    const content = await readFile(SYSTEM_LOG_PATH, 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const events: SystemEvent[] = [];
    // Parse desde el final (los más recientes)
    for (let i = lines.length - 1; i >= 0 && events.length < limit * 2; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as SystemEvent;
        if (kinds && !kinds.includes(parsed.kind)) continue;
        events.push(parsed);
        if (events.length >= limit) break;
      } catch {
        // skip línea corrupta
      }
    }
    return events.reverse(); // cronológico (más viejo → más reciente)
  } catch {
    return [];
  }
}

/**
 * Formatea los últimos eventos como texto plano amigable para inyectar
 * en system prompts de Claude. Limita a chars para no inflar el prompt.
 */
export async function formatRecentEventsForContext(
  limit = 12,
  maxChars = 2000,
): Promise<string> {
  const events = await readRecentEvents(limit);
  if (events.length === 0) return '(Sin eventos recientes registrados)';

  const lines: string[] = [];
  let totalChars = 0;
  for (const e of events) {
    const t = e.ts.slice(0, 16).replace('T', ' ');
    const summary = e.summary ?? `${e.kind}: ${JSON.stringify(e.data).slice(0, 100)}`;
    const line = `[${t}] ${e.kind} — ${summary}`;
    if (totalChars + line.length > maxChars) break;
    lines.push(line);
    totalChars += line.length;
  }
  return lines.join('\n');
}
