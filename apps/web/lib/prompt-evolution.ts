// prompt-evolution.ts — Cerebro evolutivo de la herramienta (M7 #5).
//
// CICLO DE EVOLUCIÓN AUTOMÁTICA DE PROMPTS:
//
//   1. detectSystemicPatterns()
//      Lee storage/system-log.jsonl + storage/error-memory/errors.jsonl + los
//      post-render-reports recientes. Detecta CLUSTERS de errores que se repiten
//      en N+ runs distintos (umbral configurable, default 3).
//      Ejemplos de patrones: "burned-in text en visuales", "duration mismatch >5s",
//      "scenes sin animar", "imágenes con mismo problema anatómico recurrente".
//
//   2. proposePromptPatch(pattern, currentPrompt)
//      Le pide a Claude Sonnet (más reasoning que Haiku) que PROPONGA un patch
//      al SYSTEM_PROMPT del bloque afectado para atacar el patrón. No reescribe
//      todo — agrega secciones, refuerza reglas, agrega excepciones.
//
//   3. recordProposedPatch(patch)
//      Persiste la propuesta en storage/prompt-patches/proposals.jsonl con
//      status='pending'. Owner revisa en /admin/prompt-patches y aprueba o rechaza.
//
//   4. applyPatch(id)
//      Si owner aprueba: escribe el patch al archivo source y loggea. NO commit
//      automático — owner decide cuándo commitear los cambios.
//
// FILOSOFÍA: el cerebro NO modifica el código por sí mismo sin consentimiento.
// Solo PROPONE. El humano sigue siendo el aprobador final — pero el sistema
// hace todo el trabajo pesado de detectar+diagnosticar+proponer la solución.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { unifiedJudge } from './unified-judge';
import { REPO_ROOT } from './paths';

// ============================================================
// SCHEMAS
// ============================================================

export const SystemicPatternSchema = z.object({
  patternId: z.string(),
  /** Categoría general del problema */
  category: z.enum([
    'burned-in-text',
    'duration-mismatch',
    'visual-quality-low',
    'animation-failure',
    'brand-incoherence',
    'subtitle-issues',
    'anatomy-error',
    'composition-error',
    'other',
  ]),
  /** Bloque/módulo del código que más probablemente cause el problema */
  affectedBlock: z.enum([
    'scene-planner',
    'image-gen-multi',
    'scene-animator',
    'rip-fidelity-aligner',
    'compositor-remotion',
    'post-render-judge',
    'editor-loop',
    'video-understander',
    'ad-analyzer',
    'other',
  ]),
  /** Cuántos runs distintos vieron este patrón */
  occurrenceCount: z.number().int().nonnegative(),
  /** IDs de runs (truncados) afectados — para auditoría */
  affectedRunIds: z.array(z.string()).max(20),
  /** Descripción concisa del patrón */
  description: z.string().min(20).max(500),
  /** Severidad acumulada (suma de severities de los issues) */
  severityScore: z.number(),
  /** Primera vez detectado en logs */
  firstSeenAt: z.string(),
  /** Última vez detectado */
  lastSeenAt: z.string(),
});
export type SystemicPattern = z.infer<typeof SystemicPatternSchema>;

export const PromptPatchProposalSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'applied']),
  pattern: SystemicPatternSchema,
  /** Archivo source que el patch modifica */
  targetFilePath: z.string(),
  /** Nombre de la const TypeScript que contiene el template literal del SYSTEM_PROMPT.
   *  Se usa para localizar el template literal donde insertar el patch sin romper el archivo .ts. */
  targetPromptVarName: z.string(),
  /** Tipo de cambio. 'addition' inserta al final del template literal del SYSTEM_PROMPT.
   *  'modification'/'reinforcement' reemplazan oldText (debe estar DENTRO del template literal).
   *  NOTA: 'removal' fue removido — el schema de newText requiere min(20) chars, lo que
   *  contradice la semántica de eliminación. Si querés "borrar" una regla, usá
   *  'modification' con un newText que la reemplace por algo más corto/neutral. */
  patchType: z.enum(['addition', 'modification', 'reinforcement']),
  /** Texto exacto a buscar DENTRO del template literal del SYSTEM_PROMPT.
   *  null si patchType='addition' (en cuyo caso se appendea al final del template literal). */
  oldText: z.string().nullable(),
  /** Texto nuevo a insertar */
  newText: z.string().min(10).max(5000),
  /** Razonamiento de Claude sobre por qué este patch ayuda */
  reasoning: z.string().min(20).max(1500),
  /** Mejora esperada cualitativa */
  expectedImprovement: z.string().min(10).max(500),
  /** Confidence de Claude en que el patch funciona (0-100) */
  confidence: z.number().min(0).max(100),
  /** Modelo Claude usado para generar la propuesta */
  proposedByModel: z.string(),
  /** Cuándo y por quién se aprobó/rechazó (si aplica) */
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  /** Si applied=true, qué hash de commit (opcional, manual) */
  appliedCommitHash: z.string().optional(),
});
export type PromptPatchProposal = z.infer<typeof PromptPatchProposalSchema>;

// ============================================================
// STORAGE
// ============================================================

function patchesProposalsPath(): string {
  // Storage unificado (VF_STORAGE_DIR = <root>/storage); fallback cwd para scripts.
  return resolve(
    process.env['VF_STORAGE_DIR'] ?? resolve(process.cwd(), 'storage'),
    'prompt-patches',
    'proposals.jsonl',
  );
}

export async function recordProposedPatch(
  patch: Omit<PromptPatchProposal, 'id' | 'createdAt' | 'status'>,
): Promise<string> {
  const path = patchesProposalsPath();
  await mkdir(dirname(path), { recursive: true });
  const full: PromptPatchProposal = {
    ...patch,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  await appendFile(path, JSON.stringify(full) + '\n', 'utf-8');
  return full.id;
}

export async function listAllPatchProposals(): Promise<PromptPatchProposal[]> {
  const path = patchesProposalsPath();
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as PromptPatchProposal;
      } catch {
        return null;
      }
    })
    .filter((x): x is PromptPatchProposal => x !== null);
}

export async function listPendingPatchProposals(): Promise<PromptPatchProposal[]> {
  const all = await listAllPatchProposals();
  return all.filter((p) => p.status === 'pending');
}

/**
 * Reescribe el archivo JSONL con el estado actualizado de UN patch. Implementado
 * con rewrite completo (no in-place update). OK para volúmenes esperados (< 1000
 * propuestas en años de uso).
 *
 * SEQUENCING (mutex): el patrón read-modify-write tiene una race condition
 * clásica — si dos aprobaciones llegan concurrentemente, podrían leer la misma
 * versión del archivo y la segunda escritura pisaría la primera (lost write).
 * Acá serializamos via promise chain — todas las escrituras esperan a la previa.
 */
let _updateChain: Promise<unknown> = Promise.resolve();

async function updatePatchStatus(
  patchId: string,
  update: Partial<Pick<PromptPatchProposal, 'status' | 'decidedAt' | 'decidedBy' | 'appliedCommitHash'>>,
): Promise<PromptPatchProposal | null> {
  // Encadenamos: esperar a que la última escritura termine antes de empezar
  // nuestra read-modify-write. Si la chain se rompe (rejection), reseteamos a
  // resolved para no bloquear forever.
  const myTurn = _updateChain.catch(() => undefined).then(async () => {
    const all = await listAllPatchProposals();
    const found = all.find((p) => p.id === patchId);
    if (!found) return null;
    Object.assign(found, update);
    const path = patchesProposalsPath();
    const newContent = all.map((p) => JSON.stringify(p)).join('\n') + '\n';
    await writeFile(path, newContent, 'utf-8');
    return found;
  });
  _updateChain = myTurn;
  return myTurn;
}

// ============================================================
// DETECTOR DE PATRONES
// ============================================================

interface SystemEventLite {
  ts: string;
  kind: string;
  data: Record<string, unknown>;
  summary?: string;
}

async function readRecentEvents(maxAgeDays: number = 30): Promise<SystemEventLite[]> {
  const path = resolve(
    process.env['VF_STORAGE_DIR'] ?? resolve(process.cwd(), 'storage'),
    'system-log.jsonl',
  );
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    // Permisos / race / disk error → ignoramos, no es crítico para el detector
    return [];
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as SystemEventLite;
      } catch {
        return null;
      }
    })
    .filter((x): x is SystemEventLite => x !== null)
    .filter((e) => {
      // Validar timestamp: si ts es inválido, ignoramos el event (no NaN/Invalid Date)
      const t = new Date(e.ts).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
}

/**
 * Lee post-render-reports recientes de runs en storage/runs/ y devuelve los
 * issues consolidados. Best-effort — runs sin reporte se ignoran.
 */
async function readRecentPostRenderIssues(
  maxRuns: number = 50,
): Promise<Array<{ runId: string; issues: Array<{ severity: string; category: string; description: string; sceneIndex?: number }> }>> {
  // Probamos dos paths típicos: cwd=apps/web vs cwd=root
  const runsCandidates = [
    resolve(process.cwd(), 'storage', 'runs'),
    resolve(REPO_ROOT, 'storage', 'runs'),
  ];
  let runsDir: string | null = null;
  for (const c of runsCandidates) {
    if (existsSync(c)) {
      runsDir = c;
      break;
    }
  }
  if (!runsDir) return [];

  const { readdir, stat } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }

  // Ordenar por mtime descendiente (más recientes primero)
  const withMtime = await Promise.all(
    entries.map(async (e) => {
      try {
        const s = await stat(resolve(runsDir!, e));
        return s.isDirectory() ? { name: e, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  const sorted = withMtime
    .filter((x): x is { name: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxRuns);

  const results: Awaited<ReturnType<typeof readRecentPostRenderIssues>> = [];
  for (const { name } of sorted) {
    const reportPath = resolve(runsDir, name, 'post-render-report.json');
    if (!existsSync(reportPath)) continue;
    try {
      const report = JSON.parse(await readFile(reportPath, 'utf-8')) as {
        issues?: Array<{ severity: string; category: string; description: string; sceneIndex?: number }>;
      };
      if (Array.isArray(report.issues) && report.issues.length > 0) {
        results.push({ runId: name, issues: report.issues });
      }
    } catch {
      /* ignored */
    }
  }
  return results;
}

export interface DetectPatternOptions {
  /** Mínimo de runs distintos donde el patrón debe aparecer para considerarlo sistémico. Default 3. */
  minOccurrences?: number;
  /** Cuántos días hacia atrás mirar. Default 30. */
  maxAgeDays?: number;
  /** Cuántos runs máximo escanear. Default 50. */
  maxRuns?: number;
}

/**
 * Escanea logs + post-render-reports y devuelve clusters de errores recurrentes.
 *
 * Estrategia de detección por categoría:
 *   - burned-in-text: issues con keywords "burned", "gibberish", "no text", "wrong language" en description
 *   - duration-mismatch: issues con category 'duration' o description que menciona "mismatch", "audio dura"
 *   - visual-quality-low: issues con category 'visual-quality' y score < 70 en description
 *   - animation-failure: issues que mencionan "no se animó", "static", "missing video"
 *   - brand-incoherence: issues con "brand", "no muestra producto", "incoherente"
 */
export async function detectSystemicPatterns(
  opts: DetectPatternOptions = {},
): Promise<SystemicPattern[]> {
  const minOccurrences = opts.minOccurrences ?? 3;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const maxRuns = opts.maxRuns ?? 50;

  const [events, postRenderRuns] = await Promise.all([
    readRecentEvents(maxAgeDays),
    readRecentPostRenderIssues(maxRuns),
  ]);

  // Clasificar cada issue por categoría
  type IssueWithMeta = {
    runId: string;
    severity: string;
    category: string;
    description: string;
    sceneIndex?: number;
    seenAt: string;
    inferredCategory: SystemicPattern['category'];
  };

  const allIssues: IssueWithMeta[] = [];
  // Aproximamos seenAt usando el orden de runs (más reciente = ahora; el resto va escalonado)
  const nowIso = new Date().toISOString();

  for (const run of postRenderRuns) {
    for (const issue of run.issues) {
      const desc = issue.description.toLowerCase();
      let inferredCategory: SystemicPattern['category'] = 'other';
      if (/burned.?in|gibberish|no text|wrong.?language|texto incrustado/i.test(desc)) {
        inferredCategory = 'burned-in-text';
      } else if (
        /duration|mismatch|audio dura|scene plan|scenes duran/i.test(desc) ||
        /^duration/i.test(issue.category)
      ) {
        inferredCategory = 'duration-mismatch';
      } else if (
        /no se animó|no animation|static|missing video|sin animar|falló animación/i.test(desc) ||
        /animation/i.test(issue.category)
      ) {
        inferredCategory = 'animation-failure';
      } else if (
        /score visual|visual-quality|imagen reprobó/i.test(desc) ||
        /visual-quality/i.test(issue.category)
      ) {
        inferredCategory = 'visual-quality-low';
      } else if (
        /brand|producto|marca|coherenc|no muestra|sublingual|en la mano/i.test(desc)
      ) {
        inferredCategory = 'brand-incoherence';
      } else if (/subtítulo|subtitle|ortograf|idioma/i.test(desc)) {
        inferredCategory = 'subtitle-issues';
      } else if (/dedo|mano|cara|rostro|anatom/i.test(desc)) {
        inferredCategory = 'anatomy-error';
      } else if (/composición|composition|panel|layout/i.test(desc)) {
        inferredCategory = 'composition-error';
      }
      allIssues.push({
        runId: run.runId,
        severity: issue.severity,
        category: issue.category,
        description: issue.description,
        sceneIndex: issue.sceneIndex,
        seenAt: nowIso,
        inferredCategory,
      });
    }
  }

  // Agrupar por inferredCategory y filtrar por minOccurrences (cuenta RUNS distintos)
  const byCategory = new Map<SystemicPattern['category'], IssueWithMeta[]>();
  for (const issue of allIssues) {
    if (!byCategory.has(issue.inferredCategory)) {
      byCategory.set(issue.inferredCategory, []);
    }
    byCategory.get(issue.inferredCategory)!.push(issue);
  }

  // Mapping category → bloque más probablemente causante
  const categoryToBlock: Record<SystemicPattern['category'], SystemicPattern['affectedBlock']> = {
    'burned-in-text': 'scene-planner',
    'duration-mismatch': 'scene-planner',
    'visual-quality-low': 'image-gen-multi',
    'animation-failure': 'scene-animator',
    'brand-incoherence': 'scene-planner',
    'subtitle-issues': 'post-render-judge',
    'anatomy-error': 'scene-planner',
    'composition-error': 'rip-fidelity-aligner',
    other: 'other',
  };

  const severityScore = (s: string): number => (s === 'critical' ? 3 : s === 'warning' ? 1 : 0.5);

  const patterns: SystemicPattern[] = [];
  for (const [category, issues] of byCategory.entries()) {
    const distinctRuns = new Set(issues.map((i) => i.runId));
    if (distinctRuns.size < minOccurrences) continue;

    const sevSum = issues.reduce((acc, i) => acc + severityScore(i.severity), 0);
    const sampleDesc = issues[0]!.description.slice(0, 200);
    patterns.push({
      patternId: `pat_${category}_${Date.now().toString(36)}`,
      category,
      affectedBlock: categoryToBlock[category],
      occurrenceCount: distinctRuns.size,
      affectedRunIds: [...distinctRuns].slice(0, 20).map((r) => r.slice(0, 12)),
      description: `Patrón "${category}" detectado en ${distinctRuns.size} runs distintos. Ej: "${sampleDesc}..."`,
      severityScore: sevSum,
      firstSeenAt: nowIso, // aproximación — sin granularidad histórica por ahora
      lastSeenAt: nowIso,
    });
  }

  // NOTA: en futuras versiones, podemos también analizar `events` (system-log)
  // para detectar patrones cross-cutting que no aparecen en post-render-reports
  // — ej. frecuencia de 'run-failed' por preset, patrones de uso. Por ahora
  // los events están disponibles via `events` pero no se procesan.
  void events; // reservado para futura expansión

  return patterns.sort((a, b) => b.severityScore - a.severityScore);
}

// ============================================================
// PROPONER PATCH CON CLAUDE
// ============================================================

const PATCH_PROPOSER_SYSTEM = `Sos un ingeniero senior + prompt engineer que mantiene un sistema de generación de videos con IA. Tu tarea: ANALIZAR un PATRÓN de error sistémico que se repite en N runs distintos, y PROPONER un patch al SYSTEM_PROMPT del bloque afectado para que el problema deje de ocurrir.

Recibís:
- El patrón detectado (categoría, descripción, runs afectados, severity)
- El SYSTEM_PROMPT actual del bloque (puede ser largo: 100-500 líneas)
- El nombre del bloque

Tu output: una propuesta CONCRETA de cambio. NO reescribas el prompt entero — agregá / modificá / reforzá las secciones específicas que ataquen el patrón.

Estrategias por categoría:
- burned-in-text: agregar regla más AGRESIVA con repetición + ejemplos negativos explícitos
- duration-mismatch: agregar regla de "verificar que sum(scene.endSec) === audio.duration"
- visual-quality-low: refinar el styleBase requirement, agregar references más específicas
- animation-failure: revisar fallbacks, agregar instrucciones para preservar imageRef
- brand-incoherence: forzar uso del productDescription en cada scene que muestre producto
- anatomy-error: reforzar las reglas anatómicas (manos, pies, rostros)

REGLAS:
1. patchType: 'reinforcement' es preferido si la regla ya existe (solo reforzar tono); 'addition' para reglas NUEVAS; 'modification' para reemplazar texto específico.
2. Si modification/reinforcement: oldText DEBE ser un fragmento EXACTO del SYSTEM_PROMPT actual. Si addition: oldText=null.
3. newText debe ser entre 50-1500 caracteres. Si es addition al final, empieza con "\\n\\n" para separar.
4. NO inventes texto que no se relacione con el patrón. NO cambies la estructura general del prompt.
5. confidence: cuán seguro estás de que este patch RESUELVE el patrón (0-100). Conservador: 60-75 típicamente.
6. NO uses backticks (\`) en oldText ni newText — romperían el template literal del SYSTEM_PROMPT.

Devolvé EXCLUSIVAMENTE JSON sin markdown:

{
  "patchType": "addition" | "modification" | "reinforcement",
  "oldText": "<fragmento EXACTO del prompt actual, o null si addition>",
  "newText": "<texto nuevo a insertar>",
  "reasoning": "<por qué este patch ataca el patrón, 2-3 oraciones>",
  "expectedImprovement": "<qué resultado esperás ver en runs futuros>",
  "confidence": <0-100>
}`;

const PatchProposalOutputSchema = z.object({
  patchType: z.enum(['addition', 'modification', 'reinforcement']),
  oldText: z.string().nullable(),
  newText: z.string().min(20).max(5000),
  reasoning: z.string().min(20).max(1500),
  expectedImprovement: z.string().min(10).max(500),
  confidence: z.number().min(0).max(100),
});

export interface ProposePatchOptions {
  pattern: SystemicPattern;
  /** Path absoluto al archivo source que contiene el SYSTEM_PROMPT */
  targetFilePath: string;
  /** Nombre de la const en el archivo source (ej. 'SYSTEM_INSTRUCTION', 'SYSTEM_PROMPT') */
  targetPromptVarName: string;
  /** El SYSTEM_PROMPT actual extraído del archivo */
  currentPromptText: string;
  /** Modelo Claude. Default sonnet-4-5 (mejor reasoning para esta tarea). */
  model?: string;
}

export async function proposePromptPatch(
  opts: ProposePatchOptions,
): Promise<{
  proposal: PromptPatchProposal;
  proposalId: string;
}> {
  const model = opts.model ?? 'claude-sonnet-4-5';
  const userMsg = `BLOQUE AFECTADO: ${opts.pattern.affectedBlock}
PATRÓN DETECTADO:
  - Categoría: ${opts.pattern.category}
  - Occurrences: ${opts.pattern.occurrenceCount} runs distintos
  - Severity acumulada: ${opts.pattern.severityScore}
  - Descripción: ${opts.pattern.description}
  - Runs afectados (sample): ${opts.pattern.affectedRunIds.slice(0, 5).join(', ')}

SYSTEM_PROMPT ACTUAL del bloque (target: ${opts.targetFilePath.split(/[\\/]/).pop()}):
"""
${opts.currentPromptText.slice(0, 8000)}${opts.currentPromptText.length > 8000 ? '\n... (truncado a 8000 chars)' : ''}
"""

Proponé el patch JSON.`;

  const result = await unifiedJudge({
    roleSystemPrompt: PATCH_PROPOSER_SYSTEM,
    userContent: userMsg,
    schema: PatchProposalOutputSchema,
    model,
    temperature: 0.2,
    maxTokens: 2048,
  });
  if (result.isErr()) {
    throw new Error(`Patch proposer falló: ${result.error.message}`);
  }
  const out = result.value;

  const proposalDraft: Omit<PromptPatchProposal, 'id' | 'createdAt' | 'status'> = {
    pattern: opts.pattern,
    targetFilePath: opts.targetFilePath,
    targetPromptVarName: opts.targetPromptVarName,
    patchType: out.patchType,
    oldText: out.oldText,
    newText: out.newText,
    reasoning: out.reasoning,
    expectedImprovement: out.expectedImprovement,
    confidence: out.confidence,
    proposedByModel: model,
  };
  const proposalId = await recordProposedPatch(proposalDraft);
  const proposal: PromptPatchProposal = {
    ...proposalDraft,
    id: proposalId,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  return { proposal, proposalId };
}

// ============================================================
// APLICAR / RECHAZAR PATCH
// ============================================================

/**
 * Aplica un patch APROBADO al archivo source. Modifica el texto en disco.
 * NO commitea ni reinicia el server — eso queda al owner.
 *
 * Cambia el status del patch a 'applied'. Si el cambio falla (oldText no
 * encontrado), deja el patch en 'approved' y devuelve error.
 */
export async function applyPatch(
  patchId: string,
  approver: string = 'owner',
): Promise<{ applied: boolean; error?: string; updatedFilePath?: string }> {
  const all = await listAllPatchProposals();
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { applied: false, error: 'Patch no encontrado' };
  if (patch.status === 'applied') return { applied: false, error: 'Patch ya fue aplicado' };
  if (patch.status === 'rejected') return { applied: false, error: 'Patch fue rechazado' };

  if (!existsSync(patch.targetFilePath)) {
    return { applied: false, error: `Archivo target no existe: ${patch.targetFilePath}` };
  }

  const source = await readFile(patch.targetFilePath, 'utf-8');

  // SAFETY: el patch SIEMPRE opera DENTRO del template literal del SYSTEM_PROMPT,
  // NUNCA fuera. Si appendeáramos directo al final del archivo .ts, romperíamos
  // la sintaxis TypeScript. Por eso localizamos el template literal por su
  // varName y modificamos SOLO su contenido entre backticks.
  const varName = patch.targetPromptVarName;
  // Regex: [export ]const|let|var NAME [: type]? = `<contenido>`;
  // Soporta `export const` (preview-judge expone SYSTEM_PROMPT así). VarName
  // escapado por defensa en profundidad contra regex injection.
  const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const promptRe = new RegExp(
    `((?:export\\s+)?(?:const|let|var)\\s+${escapedVarName}(?:\\s*:[^=]+)?\\s*=\\s*)\`([\\s\\S]*?)\`(;)`,
    'm',
  );
  const match = promptRe.exec(source);
  if (!match) {
    return {
      applied: false,
      error: `No se encontró la const "${varName}" como template literal en ${patch.targetFilePath}. El source cambió desde la propuesta.`,
    };
  }
  const [fullMatch, prefix, currentContent, suffix] = match;
  if (!prefix || currentContent === undefined || !suffix) {
    return { applied: false, error: 'Regex match malformado (caso interno improbable)' };
  }

  // Calculamos el nuevo contenido SOLO del template literal
  let newContent: string;
  if (patch.patchType === 'addition' && patch.oldText === null) {
    // Apéndice al final del SYSTEM_PROMPT (DENTRO de los backticks)
    newContent = currentContent + patch.newText;
  } else if (patch.oldText === null) {
    return {
      applied: false,
      error: 'patchType modification/reinforcement/removal requiere oldText, pero es null. Revisar propuesta.',
    };
  } else {
    if (!currentContent.includes(patch.oldText)) {
      return {
        applied: false,
        error: `oldText NO encontrado dentro del template literal de "${varName}". Patch desactualizado (¿se editó el source manualmente desde la propuesta?).`,
      };
    }
    // Validar que oldText NO contenga un backtick (rompería el template literal)
    if (patch.oldText.includes('`') || patch.newText.includes('`')) {
      return {
        applied: false,
        error: 'oldText/newText contiene backtick (`) que rompería el template literal. Patch rechazado por seguridad.',
      };
    }
    newContent = currentContent.replace(patch.oldText, patch.newText);
  }

  // Validación extra: el newContent nunca debe terminar con backslash sin escapar
  // (eso escaparía el cierre del backtick). Defensivo.
  if (newContent.endsWith('\\')) {
    return {
      applied: false,
      error: 'newContent termina en backslash sin escapar — rompería el template literal. Patch rechazado.',
    };
  }

  // Reconstruir el archivo source con el template literal modificado
  const updated = source.replace(fullMatch, `${prefix}\`${newContent}\`${suffix}`);

  await writeFile(patch.targetFilePath, updated, 'utf-8');
  await updatePatchStatus(patchId, {
    status: 'applied',
    decidedAt: new Date().toISOString(),
    decidedBy: approver,
  });
  return { applied: true, updatedFilePath: patch.targetFilePath };
}

export async function rejectPatch(
  patchId: string,
  approver: string = 'owner',
): Promise<{ rejected: boolean; error?: string }> {
  const updated = await updatePatchStatus(patchId, {
    status: 'rejected',
    decidedAt: new Date().toISOString(),
    decidedBy: approver,
  });
  if (!updated) return { rejected: false, error: 'Patch no encontrado' };
  return { rejected: true };
}
