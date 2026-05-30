// ╔══════════════════════════════════════════════════════════════════════════╗
// ║              OWNER FEEDBACK — Human-in-the-loop layer                    ║
// ║                                                                          ║
// ║  Captura las intervenciones del owner durante un rip (live co-pilot) y  ║
// ║  las acumula para que:                                                   ║
// ║    1. El pipeline las respete inmediatamente (approve/reject/skip)      ║
// ║    2. VALIDATOR las use como guidance en escenas posteriores            ║
// ║    3. El cerebro evolutivo aprenda patrones cross-run                   ║
// ║                                                                          ║
// ║  Tres niveles de persistencia:                                           ║
// ║    • interventions.jsonl       — inbox de acciones pendientes per-run   ║
// ║    • run-feedback.jsonl        — historial completo del run (auditoría) ║
// ║    • cross-run-memory          — comments indexados brand+preset        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { STORAGE_DIR } from './paths';
import { VALIDATOR_STORAGE_ABS } from './validator-chat-ia';

// ─── Schema de intervenciones ──────────────────────────────────────────────

export const InterventionTypeSchema = z.enum([
  'approve',        // owner force-accept la scene (skip future VALIDATOR turns)
  'reject',         // owner force-reject + opcionalmente prompt corregido
  'comment',        // observación que NO bloquea pero alimenta aprendizaje
  'skip',           // continuar sin validar (acepta tal cual)
  'redirect-attention', // pide a VALIDATOR mirar específicamente algo
]);
export type InterventionType = z.infer<typeof InterventionTypeSchema>;

export const InterventionCategorySchema = z.enum([
  'style',         // estilo visual (acuarela, sepia, comic, etc.)
  'anatomy',       // problemas anatómicos
  'narrative',     // alineación con narración
  'brand',         // brand consistency
  'composition',   // encuadre
  'motion',        // animación
  'text',          // burned-in text
  'character',     // diseño de personaje
  'pacing',        // ritmo / sincronía
  'general',       // sin categoría específica
]);
export type InterventionCategory = z.infer<typeof InterventionCategorySchema>;

export const OwnerInterventionSchema = z.object({
  /** ID único — timestamp + random suffix. */
  id: z.string(),
  runId: z.string(),
  /** Scene a la que aplica. null = comment global del run. */
  sceneIndex: z.number().int().nonnegative().nullable(),
  timestampIso: z.string(),
  type: InterventionTypeSchema,
  category: InterventionCategorySchema.optional().nullable(),
  /** Texto libre del owner. */
  comment: z.string().min(1).max(2000).optional().nullable(),
  /** Si type=reject, prompt nuevo que el pipeline debe usar para regen. */
  newImagePrompt: z.string().max(3000).optional().nullable(),
  /** Si type=reject + animation también roto, motion prompt nuevo. */
  newMotionPrompt: z.string().max(2000).optional().nullable(),
  /** Contexto al momento de la intervención (para auditoría). */
  context: z
    .object({
      validatorVerdict: z.enum(['right', 'wrong']).optional().nullable(),
      validatorConfidence: z.number().optional().nullable(),
      brandId: z.string().optional().nullable(),
      presetId: z.string().optional().nullable(),
      productId: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  /** True si el pipeline ya consumió esta intervención. */
  processed: z.boolean().default(false),
  /** Timestamp de cuando el pipeline la procesó. */
  processedAtIso: z.string().optional().nullable(),
});
export type OwnerIntervention = z.infer<typeof OwnerInterventionSchema>;

// ─── Paths ─────────────────────────────────────────────────────────────────

const OWNER_FEEDBACK_MEMORY_DIR = resolve(STORAGE_DIR, 'owner-feedback-memory');

function getRunInterventionsPath(runId: string): string {
  return resolve(VALIDATOR_STORAGE_ABS, runId, 'interventions.jsonl');
}

function getRunFeedbackPath(runId: string): string {
  return resolve(VALIDATOR_STORAGE_ABS, runId, 'run-feedback.jsonl');
}

function getCrossRunMemoryPath(brandId: string, presetId: string): string {
  // Sanitize ids por filesystem (no slashes/colons)
  const safeBrand = brandId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  const safePreset = presetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return resolve(OWNER_FEEDBACK_MEMORY_DIR, safeBrand, `${safePreset}.jsonl`);
}

// ─── Mutex global para evitar corruption con concurrent appends ────────────

let writeLock: Promise<void> = Promise.resolve();
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void = () => undefined;
  writeLock = new Promise<void>((r) => {
    release = r;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ─── API: recordIntervention ───────────────────────────────────────────────

export interface RecordInterventionInput {
  runId: string;
  sceneIndex: number | null;
  type: InterventionType;
  category?: InterventionCategory | null;
  comment?: string | null;
  newImagePrompt?: string | null;
  newMotionPrompt?: string | null;
  context?: OwnerIntervention['context'];
}

/**
 * Persiste una intervención del owner. Escribe a 3 lugares:
 *   1. interventions.jsonl — inbox de acciones pendientes (pipeline lo polea)
 *   2. run-feedback.jsonl — historial completo (auditoría)
 *   3. cross-run-memory   — solo para 'comment' (no para approve/reject que son
 *      acciones puntuales sin valor cross-run)
 */
export async function recordIntervention(
  input: RecordInterventionInput,
): Promise<OwnerIntervention> {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const intervention: OwnerIntervention = {
    id,
    runId: input.runId,
    sceneIndex: input.sceneIndex,
    timestampIso: new Date().toISOString(),
    type: input.type,
    category: input.category ?? null,
    comment: input.comment ?? null,
    newImagePrompt: input.newImagePrompt ?? null,
    newMotionPrompt: input.newMotionPrompt ?? null,
    context: input.context ?? null,
    processed: false,
    processedAtIso: null,
  };

  await withWriteLock(async () => {
    // 1. interventions.jsonl (inbox)
    const interventionsPath = getRunInterventionsPath(input.runId);
    await mkdir(resolve(VALIDATOR_STORAGE_ABS, input.runId), { recursive: true });
    await appendFile(interventionsPath, JSON.stringify(intervention) + '\n', 'utf-8');

    // 2. run-feedback.jsonl (history)
    const feedbackPath = getRunFeedbackPath(input.runId);
    await appendFile(feedbackPath, JSON.stringify(intervention) + '\n', 'utf-8');

    // 3. cross-run memory — v3.2 #140 FIX (29-may-2026):
    // ANTES: solo guardaba type==='comment'. BUG: los rechazos ("Rechazar y
    // regenerar") venían como type==='reject' y NUNCA llegaban al knowledge
    // base — justo el feedback MÁS valioso (el owner dice "esto está mal,
    // quiero esto otro"). Resultado: cross-run memory vacía + scene-planner
    // sin aprender nada cross-run.
    // AHORA: guardamos CUALQUIER intervención con comentario substantivo y
    // contexto brand+preset, sin importar el type. Un reject con comentario,
    // un approve con observación, o un comment puro — todos son señal.
    if (
      intervention.comment &&
      intervention.comment.trim().length > 5 &&
      intervention.context?.brandId &&
      intervention.context?.presetId &&
      intervention.type !== 'skip'
    ) {
      const memPath = getCrossRunMemoryPath(
        intervention.context.brandId,
        intervention.context.presetId,
      );
      await mkdir(resolve(memPath, '..'), { recursive: true });
      await appendFile(memPath, JSON.stringify(intervention) + '\n', 'utf-8');
    }
  });

  return intervention;
}

// ─── API: readPendingInterventions ─────────────────────────────────────────

/**
 * Lee las intervenciones NO procesadas para un run específico. Opcionalmente
 * filtra por sceneIndex. El pipeline llama esto antes/después de cada turno
 * del VALIDATOR para incorporar overrides del owner.
 */
export async function readPendingInterventions(
  runId: string,
  filterSceneIndex?: number,
): Promise<OwnerIntervention[]> {
  const path = getRunInterventionsPath(runId);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    const all = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): OwnerIntervention | null => {
        try {
          return JSON.parse(l) as OwnerIntervention;
        } catch {
          return null;
        }
      })
      .filter((x): x is OwnerIntervention => x !== null);
    return all.filter((i) => {
      if (i.processed) return false;
      if (filterSceneIndex !== undefined && i.sceneIndex !== filterSceneIndex && i.sceneIndex !== null)
        return false;
      return true;
    });
  } catch {
    return [];
  }
}

// ─── API: markInterventionProcessed ────────────────────────────────────────

/**
 * Marca una intervención como consumida. Reescribe el JSONL completo (atomic
 * via temp file) para preservar el orden. Para scale podríamos optimizar a
 * un índice separado, pero per-run el volumen es chico.
 */
export async function markInterventionProcessed(
  runId: string,
  interventionId: string,
): Promise<void> {
  await withWriteLock(async () => {
    const path = getRunInterventionsPath(runId);
    if (!existsSync(path)) return;
    const raw = await readFile(path, 'utf-8');
    const all = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): OwnerIntervention | null => {
        try {
          return JSON.parse(l) as OwnerIntervention;
        } catch {
          return null;
        }
      })
      .filter((x): x is OwnerIntervention => x !== null);

    const updated = all.map((i) =>
      i.id === interventionId ? { ...i, processed: true, processedAtIso: new Date().toISOString() } : i,
    );
    // Atomic write via temp + rename
    const tempPath = path + '.tmp';
    await writeFile(
      tempPath,
      updated.map((i) => JSON.stringify(i)).join('\n') + '\n',
      'utf-8',
    );
    // En Windows, rename sobre un existente puede fallar. Usamos writeFile sobre el target.
    await writeFile(
      path,
      updated.map((i) => JSON.stringify(i)).join('\n') + '\n',
      'utf-8',
    );
    try {
      await import('node:fs/promises').then((m) => m.unlink(tempPath));
    } catch {
      /* tempPath puede no existir */
    }
  });
}

// ─── API: readAllRunFeedback (full history para auditoría) ─────────────────

export async function readAllRunFeedback(runId: string): Promise<OwnerIntervention[]> {
  const path = getRunFeedbackPath(runId);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): OwnerIntervention | null => {
        try {
          return JSON.parse(l) as OwnerIntervention;
        } catch {
          return null;
        }
      })
      .filter((x): x is OwnerIntervention => x !== null);
  } catch {
    return [];
  }
}

// ─── API: getRelevantCommentsForContext (cross-run memory lookup) ──────────

export interface OwnerCommentRetrievalInput {
  brandId: string;
  presetId: string;
  /** Opcional: contexto de la escena actual para filtrado relevancia. */
  sceneNarration?: string;
  sceneShotType?: string;
  sceneNarrativeBeat?: string;
  /** Cuántos comments traer (más recientes priorizados). Default 10. */
  limit?: number;
}

/**
 * Recupera comments del owner en runs PREVIOS del mismo brand+preset.
 * VALIDATOR usa esto como contexto: "esto es lo que el owner típicamente
 * señala mal — buscá patrones similares".
 *
 * Heurística de relevancia: si scene context viene, priorizar comments que
 * compartan keywords con la narración actual.
 */
export async function getRelevantCommentsForContext(
  input: OwnerCommentRetrievalInput,
): Promise<OwnerIntervention[]> {
  const path = getCrossRunMemoryPath(input.brandId, input.presetId);
  if (!existsSync(path)) return [];
  const limit = input.limit ?? 10;
  try {
    const raw = await readFile(path, 'utf-8');
    const all = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): OwnerIntervention | null => {
        try {
          return JSON.parse(l) as OwnerIntervention;
        } catch {
          return null;
        }
      })
      .filter((x): x is OwnerIntervention => x !== null && Boolean(x.comment));

    // Si tenemos narración, filtrar por keyword overlap (heurística simple)
    if (input.sceneNarration) {
      const sceneTokens = new Set(
        input.sceneNarration
          .toLowerCase()
          .split(/\W+/)
          .filter((t) => t.length >= 4),
      );
      const scored = all.map((c) => {
        const cTokens = new Set(
          (c.comment ?? '')
            .toLowerCase()
            .split(/\W+/)
            .filter((t) => t.length >= 4),
        );
        let overlap = 0;
        for (const t of sceneTokens) if (cTokens.has(t)) overlap += 1;
        return { c, overlap };
      });
      scored.sort((a, b) => b.overlap - a.overlap);
      // Priorizar overlap > 0; si no hay, devolver los más recientes
      const withOverlap = scored.filter((s) => s.overlap > 0).map((s) => s.c);
      if (withOverlap.length >= limit) return withOverlap.slice(0, limit);
      // Fill con los más recientes
      const remaining = all
        .filter((c) => !withOverlap.includes(c))
        .sort((a, b) => b.timestampIso.localeCompare(a.timestampIso));
      return [...withOverlap, ...remaining].slice(0, limit);
    }
    // Sin contexto: los más recientes
    return all.sort((a, b) => b.timestampIso.localeCompare(a.timestampIso)).slice(0, limit);
  } catch {
    return [];
  }
}

// ─── API: getCommentStatsCrossRun (para cerebro evolutivo) ─────────────────

export interface CommentPatternStats {
  category: string;
  occurrenceCount: number;
  runIds: string[];
  representativeComments: string[];
}

/**
 * Para el cerebro evolutivo: agrupa comments por categoría y cuenta ocurrencias
 * cross-run. Si una categoría tiene N+ ocurrencias en runs distintos, es
 * candidato a generar un preset patch automático.
 */
export async function getCommentStatsCrossRun(
  brandId: string,
  presetId: string,
): Promise<CommentPatternStats[]> {
  const path = getCrossRunMemoryPath(brandId, presetId);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    const all = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): OwnerIntervention | null => {
        try {
          return JSON.parse(l) as OwnerIntervention;
        } catch {
          return null;
        }
      })
      .filter((x): x is OwnerIntervention => x !== null && Boolean(x.comment));

    const byCategory = new Map<string, { comments: OwnerIntervention[]; runIds: Set<string> }>();
    for (const c of all) {
      const cat = c.category ?? 'general';
      if (!byCategory.has(cat)) byCategory.set(cat, { comments: [], runIds: new Set() });
      const bucket = byCategory.get(cat)!;
      bucket.comments.push(c);
      bucket.runIds.add(c.runId);
    }

    const stats: CommentPatternStats[] = [];
    for (const [cat, bucket] of byCategory) {
      stats.push({
        category: cat,
        occurrenceCount: bucket.comments.length,
        runIds: Array.from(bucket.runIds),
        representativeComments: bucket.comments
          .slice(-3)
          .map((c) => c.comment ?? '')
          .filter((c) => c.length > 0),
      });
    }
    stats.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
    return stats;
  } catch {
    return [];
  }
}

// ─── #113: Cerebro evolutivo — auto-propose preset patches from comments ─────

const COMMENT_PATCH_THRESHOLD_RUNS = 2; // 2+ runs distintos con misma cat
const COMMENT_PATCH_THRESHOLD_COMMENTS = 3; // 3+ comments en esa cat

/**
 * Si N+ comments del owner (en runs distintos del mismo brand+preset) marcan
 * la misma categoría, esto retorna candidates a patches del preset que el
 * cerebro evolutivo (prompt-evolution) puede persistir como propuestas pendientes.
 *
 * El owner ve los candidates en /admin y decide approve/reject. NO se aplican
 * automáticamente — el consentimiento del owner es obligatorio.
 */
export interface OwnerCommentPatchCandidate {
  category: string;
  occurrenceCount: number;
  runIds: string[];
  representativeComments: string[];
  proposedNegativeInstruction: string;
  confidence: number;
}

export async function proposePatchesFromOwnerComments(
  brandId: string,
  presetId: string,
): Promise<OwnerCommentPatchCandidate[]> {
  const stats = await getCommentStatsCrossRun(brandId, presetId);
  const candidates: OwnerCommentPatchCandidate[] = [];
  for (const s of stats) {
    if (
      s.occurrenceCount < COMMENT_PATCH_THRESHOLD_COMMENTS ||
      s.runIds.length < COMMENT_PATCH_THRESHOLD_RUNS
    ) {
      continue;
    }
    // Construir instrucción negativa basada en los comentarios representativos
    const instruction = buildNegativeInstructionFromComments(s.category, s.representativeComments);
    // Confidence proporcional a # comments + # runs
    const confidence = Math.min(
      95,
      40 + s.occurrenceCount * 5 + s.runIds.length * 10,
    );
    candidates.push({
      category: s.category,
      occurrenceCount: s.occurrenceCount,
      runIds: s.runIds,
      representativeComments: s.representativeComments,
      proposedNegativeInstruction: instruction,
      confidence,
    });
  }
  return candidates;
}

function buildNegativeInstructionFromComments(
  category: string,
  representativeComments: string[],
): string {
  // Plantilla básica — el cerebro evolutivo después puede pedirle a Sonnet
  // refinarlo, pero esto da un patch usable de entrada.
  const lower = category.toLowerCase();
  let intro = '';
  if (lower === 'style') intro = 'CRITICAL — owner repeatedly flagged style drift: ';
  else if (lower === 'anatomy') intro = 'CRITICAL — owner repeatedly flagged anatomy issues: ';
  else if (lower === 'character') intro = 'CRITICAL — owner repeatedly flagged character design issues: ';
  else if (lower === 'text') intro = 'CRITICAL — owner repeatedly flagged burned-in text: ';
  else if (lower === 'brand') intro = 'CRITICAL — owner repeatedly flagged brand inconsistency: ';
  else if (lower === 'narrative') intro = 'CRITICAL — owner repeatedly flagged narrative mismatch: ';
  else if (lower === 'motion') intro = 'CRITICAL — owner repeatedly flagged motion quality issues: ';
  else intro = `CRITICAL — owner repeatedly flagged ${category}: `;

  const exampleList = representativeComments
    .map((c, i) => `(${i + 1}) "${c.slice(0, 200)}"`)
    .join('. ');
  return `${intro}${exampleList}. Ensure future generations strictly avoid these patterns.`;
}
