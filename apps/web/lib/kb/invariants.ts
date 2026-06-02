// invariants.ts — "Memoria viva del proyecto": registro de INVARIANTES, reglas
// duras y wirings no-obvios ("gotchas").
//
// Propósito: que CUALQUIER Claude (sesión nueva, post-compactación) y la IA
// in-app arranquen con la verdad ACTUAL del proyecto y NO re-descubran ni
// tropiecen (ej.: el feed de la KB ya pasa por el bridge M9 system-log → no
// duplicar). Se propaga por dos canales:
//   1. IA in-app: inyectada en system-context (cada llamada a Claude la ve).
//   2. Claude desarrollador: sincronizada a CLAUDE.md (auto-cargado por sesión)
//      vía scripts/sync-invariants.ts.
//
// Fuente de verdad: storage/kb/invariantes.jsonl (append-only; última por id gana).
// Si el store está vacío, se usa la semilla CORE_INVARIANTS (conocimiento ganado).

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KB_DIR } from './record';

const INVARIANTS_PATH = resolve(KB_DIR, 'invariantes.jsonl');
const SEED_TS = '2026-06-01T00:00:00.000Z';

export type InvariantCategoria =
  | 'idioma'
  | 'seguridad'
  | 'arquitectura'
  | 'wiring'
  | 'decision'
  | 'producto';

export interface Invariant {
  id: string;
  ts: string;
  categoria: InvariantCategoria;
  titulo: string;
  regla: string; // la regla, en imperativo
  porQue: string; // contexto / por qué existe (incl. el error que evita)
  fuente: string; // dónde vive en el código / quién la decidió
}

/** Semilla: el conocimiento duro ganado hasta hoy. Se usa si el store está vacío. */
export const CORE_INVARIANTS: Array<Omit<Invariant, 'ts'>> = [
  {
    id: 'idioma-neutro',
    categoria: 'idioma',
    titulo: 'Español neutro SIEMPRE',
    regla:
      'Toda salida (UI, chat, prompts, código, commits) en español neutro con "tú". PROHIBIDO el voseo argentino (sos/tenés/podés/hacé/mirá/decí/dale) y "acá" (usar "aquí").',
    porQue:
      'Regla crítica del owner. El chat tiene un normalizador, pero los prompts deben estar limpios en origen.',
    fuente: 'CLAUDE.md; apps/web/lib/claude-chat-discuss.ts (normalizeNeutralSpanish)',
  },
  {
    id: 'nada-auto-aplica',
    categoria: 'seguridad',
    titulo: 'Nada se auto-aplica',
    regla:
      'El sistema PROPONE; el owner aprueba. Ningún cambio de código/prompt/config se aplica sin consentimiento explícito.',
    porQue: 'Invariante de seguridad del owner. El Consejo/auditoría/evolución solo observan y proponen.',
    fuente: 'apps/web/lib/prompt-evolution.ts applyPatch (gated); kb/deep-audit.ts',
  },
  {
    id: 'kb-fed-by-system-log',
    categoria: 'wiring',
    titulo: 'La KB se alimenta vía el bridge M9 (system-log)',
    regla:
      'Los eventos de run (run-completed/failed, editor-ia-verdict, etc.) llegan a la KB SOLO vía logSystemEvent → systemEventToKb. NO agregues emisores paralelos a recordEvent para esos eventos: duplicarías.',
    porQue:
      'En jun-2026 casi se duplicó el feed creando un run-events.ts paralelo. El bridge ya existía y no estaba documentado de forma accesible.',
    fuente: 'apps/web/lib/system-log.ts (systemEventToKb); apps/web/lib/kb/record.ts',
  },
  {
    id: 'storage-unificado',
    categoria: 'arquitectura',
    titulo: 'Storage único en /storage',
    regla:
      'Todo el storage vive en <root>/storage vía VF_STORAGE_DIR (lo fuerza next.config.mjs). NO uses process.cwd() para rutas de storage.',
    porQue: 'Antes se partía entre apps/web/storage y /storage (split-brain).',
    fuente: 'apps/web/lib/paths.ts; next.config.mjs',
  },
  {
    id: 'env-root',
    categoria: 'arquitectura',
    titulo: 'El .env raíz es la única fuente de verdad',
    regla:
      'next.config.mjs carga TODO el .env raíz y SOBREESCRIBE process.env al arrancar. Vars nuevas: agrégalas al .env raíz (y .env.example).',
    porQue: 'Evita valores stale/vacíos (ANTHROPIC_API_KEY rompía el judge IA).',
    fuente: 'next.config.mjs',
  },
  {
    id: 'admin-gate',
    categoria: 'seguridad',
    titulo: 'Admin protegido por ADMIN_PASSWORD',
    regla:
      '/admin y /api/admin/* exigen cookie admin_auth (separada de app_auth). La clave vive en ADMIN_PASSWORD del .env.',
    porQue: 'El panel admin es solo para el owner.',
    fuente: 'apps/web/lib/auth.ts; apps/web/middleware.ts',
  },
  {
    id: 'no-push',
    categoria: 'decision',
    titulo: 'Nunca hacer git push sin que el owner lo pida',
    regla: 'Commits locales OK cuando el owner los pide; git push SOLO con orden explícita del owner.',
    porQue: 'Regla del owner.',
    fuente: 'owner',
  },
];

async function readRaw(): Promise<Invariant[]> {
  try {
    const raw = await readFile(INVARIANTS_PATH, 'utf-8');
    const byId = new Map<string, Invariant>();
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const inv = JSON.parse(t) as Invariant;
        byId.set(inv.id, inv); // última ocurrencia gana
      } catch {
        // skip línea corrupta
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

/** Lista las invariantes. Si el store está vacío, devuelve la semilla CORE. */
export async function listInvariants(): Promise<Invariant[]> {
  const stored = await readRaw();
  const list = stored.length > 0 ? stored : CORE_INVARIANTS.map((c) => ({ ...c, ts: SEED_TS }));
  return list.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.titulo.localeCompare(b.titulo));
}

export interface AddInvariantInput {
  categoria: InvariantCategoria;
  titulo: string;
  regla: string;
  porQue?: string;
  fuente?: string;
}

/** Agrega (o actualiza por id) una invariante. Materializa la semilla la 1ra vez. */
export async function addInvariant(i: AddInvariantInput): Promise<Invariant> {
  const slug =
    i.titulo
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || `inv-${randomUUID().slice(0, 6)}`;
  const inv: Invariant = {
    id: slug,
    ts: new Date().toISOString(),
    categoria: i.categoria,
    titulo: i.titulo,
    regla: i.regla,
    porQue: i.porQue ?? '',
    fuente: i.fuente ?? 'owner',
  };
  try {
    await mkdir(KB_DIR, { recursive: true });
    // Si el store está vacío, materializamos la semilla para no perderla al filtrar.
    const stored = await readRaw();
    if (stored.length === 0) {
      for (const c of CORE_INVARIANTS) {
        await appendFile(INVARIANTS_PATH, JSON.stringify({ ...c, ts: SEED_TS }) + '\n', 'utf-8');
      }
    }
    await appendFile(INVARIANTS_PATH, JSON.stringify(inv) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
  return inv;
}

/** Texto compacto para inyectar en system prompts (IA in-app). */
export async function formatInvariantsForContext(maxChars = 1800): Promise<string> {
  const list = await listInvariants();
  if (list.length === 0) return '';
  const lines: string[] = [];
  let total = 0;
  for (const inv of list) {
    const line = `- [${inv.categoria}] ${inv.titulo}: ${inv.regla}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

/** Markdown para sincronizar a CLAUDE.md (Claudes desarrolladores). */
export async function renderInvariantsMarkdown(): Promise<string> {
  const list = await listInvariants();
  return list
    .map(
      (inv) =>
        `- **${inv.titulo}** _(${inv.categoria})_ — ${inv.regla}` +
        (inv.porQue ? ` _Por qué:_ ${inv.porQue}` : '') +
        (inv.fuente ? ` _Fuente:_ \`${inv.fuente}\`` : ''),
    )
    .join('\n');
}
