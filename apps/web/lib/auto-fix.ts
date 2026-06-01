// ╔══════════════════════════════════════════════════════════════════════════╗
// ║              AUTO-FIX — Self-healing bug fix system                      ║
// ║                                                                          ║
// ║  Captura errores que ocurren en runtime (pipeline, endpoints, client),  ║
// ║  los analiza con Claude Sonnet, y aplica fixes automáticamente si la    ║
// ║  confidence es alta. Para casos borderline, los encola en /admin.       ║
// ║                                                                          ║
// ║  Diseño defensivo:                                                       ║
// ║    - Backup del archivo antes de cualquier edit                         ║
// ║    - Apply → typecheck → si rompe, revert                              ║
// ║    - Solo edita 1 archivo por fix, max 30 líneas modificadas           ║
// ║    - Nunca toca archivos de DB, secrets, o critical infra              ║
// ║    - Todo se logea en storage/auto-fix-journal.jsonl                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { unifiedJudge } from './unified-judge';
import { STORAGE_DIR } from './paths';

const AUTO_FIX_DIR = resolve(STORAGE_DIR, 'auto-fix');
const QUEUE_PATH = resolve(AUTO_FIX_DIR, 'queue.jsonl');
const JOURNAL_PATH = resolve(AUTO_FIX_DIR, 'journal.jsonl');
const BACKUPS_DIR = resolve(AUTO_FIX_DIR, 'backups');

const MIN_CONFIDENCE_TO_AUTO_APPLY = 85;
const MAX_LINES_CHANGED_PER_FIX = 30;

// Archivos protegidos — NUNCA tocar
const FORBIDDEN_PATHS = [
  /\.env/,
  /\/db\/local\.db/,
  /\/db\/migrations\//,
  /\/node_modules\//,
  /package-lock\.json/,
  /pnpm-lock\.yaml/,
];

// ─── Schemas ────────────────────────────────────────────────────────────────

export const ErrorReportSchema = z.object({
  /** Mensaje del error. */
  message: z.string().min(1),
  /** Stack trace (opcional pero ayuda mucho). */
  stack: z.string().optional(),
  /** Archivo donde ocurrió (path absoluto o relativo a repo). */
  filePath: z.string().optional(),
  /** Línea aproximada. */
  line: z.number().optional(),
  /** Contexto adicional (descripción humana de qué se intentaba hacer). */
  context: z.string().optional(),
  /** Origen del error. */
  source: z.enum(['client', 'server', 'pipeline', 'validator', 'manual']),
  /** Timestamp. */
  timestampIso: z.string(),
  /** ID único para deduping. */
  id: z.string(),
});
export type ErrorReport = z.infer<typeof ErrorReportSchema>;

const FixProposalSchema = z.object({
  targetFile: z.string(),
  description: z.string(),
  oldCode: z.string(),
  newCode: z.string(),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  estimatedLinesChanged: z.number().int().nonnegative(),
  riskAssessment: z
    .union([z.enum(['low', 'medium', 'high', 'unsafe']), z.string()])
    .transform((v): 'low' | 'medium' | 'high' | 'unsafe' => {
      if (v === 'low' || v === 'medium' || v === 'high' || v === 'unsafe') return v;
      return 'medium';
    }),
});
export type FixProposal = z.infer<typeof FixProposalSchema>;

export interface AutoFixResult {
  errorId: string;
  status: 'applied' | 'queued-for-review' | 'no-fix-found' | 'rejected-too-risky' | 'apply-failed-reverted' | 'forbidden-path';
  proposal?: FixProposal;
  applyError?: string;
  backupPath?: string;
}

// ─── Capture: persist error to queue ────────────────────────────────────────

let writeLock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
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

export async function captureError(
  input: Omit<ErrorReport, 'id' | 'timestampIso'>,
): Promise<ErrorReport> {
  const report: ErrorReport = {
    ...input,
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestampIso: new Date().toISOString(),
  };
  await withLock(async () => {
    await mkdir(AUTO_FIX_DIR, { recursive: true });
    await appendFile(QUEUE_PATH, JSON.stringify(report) + '\n', 'utf-8');
  });
  return report;
}

export async function readPendingErrors(): Promise<ErrorReport[]> {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    const raw = await readFile(QUEUE_PATH, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): ErrorReport | null => {
        try {
          return JSON.parse(l) as ErrorReport;
        } catch {
          return null;
        }
      })
      .filter((x): x is ErrorReport => x !== null);
  } catch {
    return [];
  }
}

// ─── Safety: check forbidden paths ──────────────────────────────────────────

function isForbiddenPath(filePath: string): boolean {
  return FORBIDDEN_PATHS.some((re) => re.test(filePath));
}

// ─── Analysis: Claude diagnoses and proposes a fix ──────────────────────────

const AUTO_FIX_SYSTEM_PROMPT = `Eres un agente auto-fix de bugs para una codebase TypeScript Next.js. Recibes un error capturado en runtime y tu trabajo es DIAGNOSTICAR + proponer un fix concreto.

Tu output es SOLO JSON sin markdown fences:

{
  "targetFile": "<path relativo al repo, ej. apps/web/lib/foo.ts>",
  "description": "<1-2 oraciones explicando qué bug es>",
  "oldCode": "<el bloque exacto de código a reemplazar — DEBE ser único en el archivo>",
  "newCode": "<el código corregido>",
  "confidence": 0-100,
  "reasoning": "<2-4 oraciones explicando por qué tu fix resuelve el error>",
  "estimatedLinesChanged": <int>,
  "riskAssessment": "low" | "medium" | "high" | "unsafe"
}

REGLAS:
1. **oldCode debe ser ÚNICO en targetFile**. Si pensás que la frase puede aparecer varias veces, agrega contexto (líneas vecinas) para que sea inequívoca.
2. **newCode debe preservar formato + indentación** exactos del original.
3. **No toques** archivos .env, node_modules/, db/local.db, migrations.
4. **confidence**:
   - >= 90: fix obvio + bien acotado (typo, missing import, wrong type cast)
   - 75-89: fix probable pero requiere validación
   - < 75: no estás seguro → confidence baja
5. **riskAssessment**:
   - "low": cambio trivial (1-5 líneas, pure refactor)
   - "medium": cambio moderado (5-15 líneas, lógica)
   - "high": cambio grande (> 15 líneas, o impacto sistémico)
   - "unsafe": NO aplicar — requiere revisión humana
6. Si NO sabes cómo fixearlo, devuelve confidence < 60 y description="no-fix-found".

Ejemplo bueno:
Error: "TypeError: Cannot read property 'mode' of undefined at line 45 of pipeline.ts"
Output: { targetFile: "apps/web/lib/pipeline.ts", description: "row puede ser undefined", oldCode: "row.mode ?? 'auto'", newCode: "row?.mode ?? 'auto'", confidence: 95, reasoning: "Optional chaining previene el TypeError", estimatedLinesChanged: 1, riskAssessment: "low" }`;

async function diagnoseAndProposeFix(
  error: ErrorReport,
  fileContent: string | null,
): Promise<FixProposal | null> {
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey || apiKey.startsWith('ROTATE_')) return null;

  const userText = [
    `# Error capturado`,
    ``,
    `**Mensaje:** ${error.message}`,
    error.stack ? `\n**Stack:**\n\`\`\`\n${error.stack.slice(0, 2000)}\n\`\`\`` : '',
    error.filePath ? `**Archivo (heurística):** ${error.filePath}` : '',
    error.line !== undefined ? `**Línea:** ${error.line}` : '',
    error.context ? `**Contexto:** ${error.context}` : '',
    `**Source:** ${error.source}`,
    ``,
    fileContent
      ? `## Contenido actual del archivo\n\`\`\`typescript\n${fileContent.slice(0, 8000)}\n\`\`\``
      : '_(No tengo el contenido del archivo — solo propone fix si tienes certeza del bug)_',
    ``,
    `Devuelve SOLO el JSON con tu propuesta de fix.`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await unifiedJudge({
      apiKey,
      model: 'claude-sonnet-4-5',
      maxTokens: 4000,
      temperature: 0,
      timeoutMs: 90_000,
      skipProjectContext: true,
      roleSystemPrompt: AUTO_FIX_SYSTEM_PROMPT,
      userContent: userText,
      schema: FixProposalSchema,
    });
    if (result.isErr()) return null;
    return result.value;
  } catch {
    return null;
  }
}

// ─── Apply: backup + edit + typecheck + maybe revert ────────────────────────

async function applyFixWithSafety(
  proposal: FixProposal,
  repoRoot: string,
): Promise<{ success: boolean; backupPath?: string; errorMessage?: string }> {
  // Resolver path relativo al repo
  const targetAbs = resolve(repoRoot, proposal.targetFile);

  if (isForbiddenPath(targetAbs)) {
    return { success: false, errorMessage: 'forbidden path' };
  }

  if (!existsSync(targetAbs)) {
    return { success: false, errorMessage: 'target file not found' };
  }

  // Backup
  await mkdir(BACKUPS_DIR, { recursive: true });
  const backupName = `${proposal.targetFile.replace(/[\/\\]/g, '_')}.${Date.now()}.bak`;
  const backupPath = resolve(BACKUPS_DIR, backupName);
  await copyFile(targetAbs, backupPath);

  // Read + check oldCode is unique
  const original = await readFile(targetAbs, 'utf-8');
  const occurrences = original.split(proposal.oldCode).length - 1;
  if (occurrences !== 1) {
    return {
      success: false,
      backupPath,
      errorMessage: `oldCode appears ${occurrences} times in file (expected exactly 1)`,
    };
  }

  // Apply
  const patched = original.replace(proposal.oldCode, proposal.newCode);
  await writeFile(targetAbs, patched, 'utf-8');

  // Typecheck — si rompe, revert
  try {
    execSync('pnpm --filter "@video-factory/web" typecheck', {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
    return { success: true, backupPath };
  } catch (e) {
    // Typecheck falló → revert
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 1000) ?? String(e);
    await copyFile(backupPath, targetAbs);
    return {
      success: false,
      backupPath,
      errorMessage: `typecheck failed after fix, reverted. tsc stderr: ${stderr}`,
    };
  }
}

// ─── Journal ────────────────────────────────────────────────────────────────

async function logToJournal(entry: {
  timestampIso: string;
  errorId: string;
  errorMessage: string;
  result: AutoFixResult;
  proposal?: FixProposal;
}): Promise<void> {
  await withLock(async () => {
    await mkdir(AUTO_FIX_DIR, { recursive: true });
    await appendFile(JOURNAL_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  });
}

// ─── Main: process queue ────────────────────────────────────────────────────

export async function processAutoFixQueue(repoRoot: string): Promise<AutoFixResult[]> {
  const errors = await readPendingErrors();
  const results: AutoFixResult[] = [];

  for (const err of errors) {
    let fileContent: string | null = null;
    if (err.filePath) {
      const abs = resolve(repoRoot, err.filePath);
      if (existsSync(abs) && !isForbiddenPath(abs)) {
        try {
          fileContent = await readFile(abs, 'utf-8');
        } catch {
          fileContent = null;
        }
      }
    }

    const proposal = await diagnoseAndProposeFix(err, fileContent);
    let result: AutoFixResult;

    if (!proposal || proposal.confidence < 60) {
      result = { errorId: err.id, status: 'no-fix-found', proposal: proposal ?? undefined };
    } else if (proposal.riskAssessment === 'unsafe') {
      result = { errorId: err.id, status: 'rejected-too-risky', proposal };
    } else if (proposal.estimatedLinesChanged > MAX_LINES_CHANGED_PER_FIX) {
      result = { errorId: err.id, status: 'rejected-too-risky', proposal };
    } else if (isForbiddenPath(resolve(repoRoot, proposal.targetFile))) {
      result = { errorId: err.id, status: 'forbidden-path', proposal };
    } else if (proposal.confidence < MIN_CONFIDENCE_TO_AUTO_APPLY) {
      result = { errorId: err.id, status: 'queued-for-review', proposal };
    } else {
      const apply = await applyFixWithSafety(proposal, repoRoot);
      if (apply.success) {
        result = {
          errorId: err.id,
          status: 'applied',
          proposal,
          backupPath: apply.backupPath,
        };
      } else {
        result = {
          errorId: err.id,
          status: 'apply-failed-reverted',
          proposal,
          applyError: apply.errorMessage,
          backupPath: apply.backupPath,
        };
      }
    }

    await logToJournal({
      timestampIso: new Date().toISOString(),
      errorId: err.id,
      errorMessage: err.message,
      result,
      proposal: proposal ?? undefined,
    });
    results.push(result);
  }

  // Mover errores procesados a un archivo "processed.jsonl" para no re-procesar
  if (errors.length > 0) {
    await withLock(async () => {
      const processedPath = resolve(AUTO_FIX_DIR, 'processed.jsonl');
      for (const e of errors) await appendFile(processedPath, JSON.stringify(e) + '\n', 'utf-8');
      // Limpiar queue
      await writeFile(QUEUE_PATH, '', 'utf-8');
    });
  }

  return results;
}

// ─── Helpers para que callers (pipeline, etc.) reporten errores fácil ──────

export async function reportPipelineError(
  err: Error,
  context: { runId?: string; step?: string; sceneIndex?: number },
): Promise<void> {
  await captureError({
    message: err.message.slice(0, 1000),
    stack: err.stack?.slice(0, 4000),
    context: `Pipeline error · runId=${context.runId ?? '?'} · step=${context.step ?? '?'} · scene=${context.sceneIndex ?? '?'}`,
    source: 'pipeline',
  }).catch(() => {
    /* best-effort, nunca tirar desde aquí */
  });
}

export async function reportEndpointError(
  err: Error,
  context: { route: string; method: string; params?: unknown },
): Promise<void> {
  await captureError({
    message: err.message.slice(0, 1000),
    stack: err.stack?.slice(0, 4000),
    context: `Endpoint error · ${context.method} ${context.route}`,
    source: 'server',
  }).catch(() => {});
}

export interface JournalEntry {
  timestampIso: string;
  errorId: string;
  errorMessage: string;
  result: AutoFixResult;
  proposal?: FixProposal;
}

export async function readJournal(): Promise<JournalEntry[]> {
  if (!existsSync(JOURNAL_PATH)) return [];
  try {
    const raw = await readFile(JOURNAL_PATH, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l): JournalEntry | null => {
        try {
          return JSON.parse(l) as JournalEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is JournalEntry => x !== null);
  } catch {
    return [];
  }
}
