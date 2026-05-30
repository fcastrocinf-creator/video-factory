// ╔══════════════════════════════════════════════════════════════════════════╗
// ║              VALIDATOR CHAT IA — HOLISTIC SEQUENCE REVIEW                ║
// ║  Después de validar escenas individuales, VALIDATOR mira el video COMO  ║
// ║  SECUENCIA: pacing, character consistency, palette drift, narrative      ║
// ║  flow, hook strength as a whole.                                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// MOTIVACIÓN
// ─────────────────────────────────────────────────────────────────────────────
// El VALIDATOR per-scene ve UNA escena (+ 2 prev). Captura errores locales
// excelente, pero NO ve patrones de secuencia:
//   - El personaje del scene 3 se ve como otro humano en scene 7 (drift).
//   - La paleta vira de sepia tibio a frío azul (inconsistencia).
//   - Las primeras 5 escenas son hook → todas tienen la MISMA intensidad
//     visual (pierden retención por monotonía).
//   - Falta un beat de "social-proof" antes del CTA.
//
// El HOLISTIC review responde estas preguntas mirando el video como una sola
// unidad coherente. Output: lista de scenes a regenerar + recomendaciones de
// re-ordenamiento + verdict global "ready" / "needs-work".
//
// COSTO: ~$0.05-0.10 por holistic review (1 contact sheet + análisis). Una
// pasada por video, no por scene.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Scene, SceneTrack } from '@video-factory/contracts';
import { findFfmpegPath } from './ffmpeg-locator';
import {
  buildImageMessageContent,
  judgeRaw,
  type ClaudeMessageContent,
} from './unified-judge';
import {
  VALIDATOR_NAME,
  VALIDATOR_STORAGE_ABS,
  type ValidatorBrandContext,
} from './validator-chat-ia';

const HOLISTIC_MODEL = 'claude-sonnet-4-5';
const HOLISTIC_TIMEOUT_MS = 120_000;
const CONTACT_SHEET_THUMB_WIDTH = 200; // 200x355 (9:16) ≈ 95 tokens
const MAX_SCENES_IN_CONTACT_SHEET = 16; // si hay más, sampleamos evenly

// ─── Schema del veredicto holístico ─────────────────────────────────────────

const HolisticIssueSchema = z.object({
  severity: z.enum(['minor', 'major', 'critical']),
  category: z
    .union([
      z.enum([
        'character-drift', // mismo personaje cambia entre escenas
        'palette-inconsistency', // paleta vira sin justificación narrativa
        'pacing-monotone', // todas las escenas con misma intensidad
        'pacing-too-slow', // ritmo cae
        'hook-weakness', // las primeras 3s no captan atención
        'cta-missing-or-weak', // no hay close fuerte
        'narrative-jump', // gaps lógicos entre escenas
        'beat-imbalance', // demasiados beats de un tipo, faltan otros
        'redundant-scenes', // escenas que repiten lo mismo
        'other',
      ]),
      z.string(),
    ])
    .transform((v) => {
      const allowed = [
        'character-drift',
        'palette-inconsistency',
        'pacing-monotone',
        'pacing-too-slow',
        'hook-weakness',
        'cta-missing-or-weak',
        'narrative-jump',
        'beat-imbalance',
        'redundant-scenes',
        'other',
      ];
      return (allowed.includes(v as string) ? v : 'other') as
        | 'character-drift'
        | 'palette-inconsistency'
        | 'pacing-monotone'
        | 'pacing-too-slow'
        | 'hook-weakness'
        | 'cta-missing-or-weak'
        | 'narrative-jump'
        | 'beat-imbalance'
        | 'redundant-scenes'
        | 'other';
    }),
  affectedSceneIndices: z.array(z.number().int().nonnegative()),
  description: z.string().min(1).max(1000),
  fix: z.string().min(1).max(500).nullish().transform((v) => v ?? undefined),
});
export type HolisticIssue = z.infer<typeof HolisticIssueSchema>;

const scoreField = z
  .union([z.number(), z.string()])
  .transform((v) => {
    if (typeof v === 'number') return Math.max(0, Math.min(100, v));
    const m = /(\d+)/.exec(v);
    return m ? Math.max(0, Math.min(100, parseInt(m[1] ?? '0', 10))) : 0;
  });

export const HolisticVerdictSchema = z.object({
  globalVerdict: z
    .union([z.enum(['ready-to-deliver', 'needs-work', 'needs-major-rework']), z.string()])
    .transform((v): 'ready-to-deliver' | 'needs-work' | 'needs-major-rework' => {
      if (v === 'ready-to-deliver' || v === 'needs-work' || v === 'needs-major-rework') return v;
      return 'needs-work';
    }),
  scorePacing: scoreField,
  scoreCharacterConsistency: scoreField,
  scorePaletteCoherence: scoreField,
  scoreNarrativeFlow: scoreField,
  scoreHookStrength: scoreField,
  scoreCtaStrength: scoreField,
  issues: z.array(HolisticIssueSchema),
  /** Lista de índices de escenas que recomendás regenerar (por orden de prioridad). */
  recommendedRegenerateIndices: z.array(z.number().int().nonnegative()),
  /** Texto libre con recomendaciones cualitativas adicionales. */
  rationale: z.string().min(10).max(2000),
});
export type HolisticVerdict = z.infer<typeof HolisticVerdictSchema>;

// ─── System prompt ──────────────────────────────────────────────────────────

const HOLISTIC_SYSTEM_PROMPT = `Sos "${VALIDATOR_NAME} — Holistic Review", la capa de análisis SECUENCIAL del validator.

Te están mostrando UN CONTACT SHEET: una grilla de thumbnails de TODAS las escenas del video en orden temporal. Cada thumb es el primer frame de cada escena.

Tu trabajo: ver el video COMO SECUENCIA, no escena por escena. Detectá patrones que solo emergen al ver el todo:

1. CHARACTER DRIFT — el mismo personaje cambia drásticamente entre escenas (cara, género, edad, ropa, etnia) sin razón narrativa.

2. PALETTE INCONSISTENCY — la paleta vira (de sepia tibio a azul frío, etc.) sin que el guión lo justifique.

3. PACING — todas las escenas con la misma intensidad visual = monotonía = pérdida de retención. Buena pacing tiene:
   - Hook potente (escenas 1-2): alta intensidad visual + pattern interrupt.
   - Problema (3-5): emoción intensificada.
   - Mecanismo / demo (6-8): visual más calmo, foco en producto.
   - Producto / proof (9-10): hero shot + paciencia.
   - CTA (final): cierre fuerte.

4. NARRATIVE JUMPS — gaps entre escenas que rompen la lógica. Si escena 3 muestra el problema y escena 4 ya muestra el producto sin transición → jump.

5. HOOK STRENGTH — las primeras 3 segundos (~escena 1) tienen que captar a alguien scrolleando rápido. Si la primera thumb es estática/sin gesto → hook débil.

6. CTA STRENGTH — el cierre tiene que invitar a la acción. Si la última escena es un personaje neutral sin gesto de CTA → CTA débil.

7. REDUNDANCY — múltiples escenas que comunican lo mismo visualmente.

8. BEAT IMBALANCE — si el script pide hook→problem→mechanism→demo→cta y vos ves 5 hooks y 0 mechanism → falta diversidad de beats.

Devolvé SOLO un JSON con este schema (sin markdown fences):

{
  "globalVerdict": "ready-to-deliver" | "needs-work" | "needs-major-rework",
  "scorePacing": 0-100,
  "scoreCharacterConsistency": 0-100,
  "scorePaletteCoherence": 0-100,
  "scoreNarrativeFlow": 0-100,
  "scoreHookStrength": 0-100,
  "scoreCtaStrength": 0-100,
  "issues": [
    {
      "severity": "minor"|"major"|"critical",
      "category": "<una de las 10 categorías>",
      "affectedSceneIndices": [1,4,7],
      "description": "<específico>",
      "fix": "<recomendación accionable>"
    }
  ],
  "recommendedRegenerateIndices": [3, 7, 12],
  "rationale": "Resumen 2-4 oraciones de tu evaluación holística"
}

REGLA DE SCORING:
  >= 85 cada sub-score → ready-to-deliver
  70-84 algún sub-score → needs-work
  < 70 algún sub-score → needs-major-rework`;

// ─── Construcción del contact sheet ─────────────────────────────────────────

function selectScenesForContactSheet(scenes: Scene[]): { scene: Scene; pickedIndex: number }[] {
  if (scenes.length <= MAX_SCENES_IN_CONTACT_SHEET) {
    return scenes.map((s, i) => ({ scene: s, pickedIndex: i }));
  }
  // Sample evenly: pick MAX equidistant indices
  const picked: { scene: Scene; pickedIndex: number }[] = [];
  const step = (scenes.length - 1) / (MAX_SCENES_IN_CONTACT_SHEET - 1);
  for (let i = 0; i < MAX_SCENES_IN_CONTACT_SHEET; i++) {
    const idx = Math.round(i * step);
    const scene = scenes[idx];
    if (scene) picked.push({ scene, pickedIndex: idx });
  }
  return picked;
}

/**
 * Genera UN contact sheet (imagen única en grilla) con N thumbs de scenes.
 * Usa ffmpeg tile filter. Si ffmpeg falla, devuelve null y el caller debe
 * caer a sending de imágenes individuales como fallback.
 */
async function buildContactSheet(opts: {
  scenes: Array<{ scene: Scene; pickedIndex: number }>;
  outputPath: string;
  thumbWidthPx?: number;
}): Promise<{ path: string; gridCols: number; gridRows: number } | null> {
  const thumbWidth = opts.thumbWidthPx ?? CONTACT_SHEET_THUMB_WIDTH;
  // 9:16 → height = width × 16/9
  const thumbHeight = Math.round((thumbWidth * 16) / 9);
  // Grid layout — aim for ~4-5 cols max para que cada thumb sea legible
  const n = opts.scenes.length;
  const gridCols = Math.min(4, Math.ceil(Math.sqrt(n)));
  const gridRows = Math.ceil(n / gridCols);

  const ffmpegBin = findFfmpegPath();
  const inputs: string[] = [];
  for (const { scene } of opts.scenes) {
    if (scene.imagePath && existsSync(scene.imagePath)) {
      inputs.push('-i', scene.imagePath);
    }
  }
  if (inputs.length === 0) return null;
  const numInputs = inputs.length / 2;

  // Cada input se escala + label con el índice de scene
  // Para simplicidad, solo scale + tile. Labels los pone Claude en su análisis
  // basado en orden (top-left = scene picked[0], etc.) — se lo decimos en el texto.
  const filterParts: string[] = [];
  for (let i = 0; i < numInputs; i++) {
    filterParts.push(`[${i}:v]scale=${thumbWidth}:${thumbHeight}:force_original_aspect_ratio=decrease,pad=${thumbWidth}:${thumbHeight}:(ow-iw)/2:(oh-ih)/2:black[v${i}]`);
  }
  const chainRefs = Array.from({ length: numInputs }, (_, i) => `[v${i}]`).join('');
  filterParts.push(`${chainRefs}xstack=inputs=${numInputs}:layout=${buildXStackLayout(numInputs, gridCols, thumbWidth, thumbHeight)}[out]`);

  const args = [
    ...inputs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[out]',
    '-y',
    opts.outputPath,
  ];

  return new Promise((resolveFn) => {
    let stderr = '';
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    proc.on('error', () => resolveFn(null));
    proc.on('close', (code) => {
      if (code === 0 && existsSync(opts.outputPath)) {
        resolveFn({ path: opts.outputPath, gridCols, gridRows });
      } else {
        // Fallback: log y devolvé null
        resolveFn(null);
      }
    });
  });
}

/** Genera el layout string para xstack: "0_0|w0_0|0_h0|w0_h0|..." */
function buildXStackLayout(n: number, cols: number, w: number, h: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = col === 0 ? '0' : Array.from({ length: col }, () => `${w}`).join('+');
    const y = row === 0 ? '0' : Array.from({ length: row }, () => `${h}`).join('+');
    parts.push(`${x}_${y}`);
  }
  return parts.join('|');
}

// ─── API pública ────────────────────────────────────────────────────────────

export interface HolisticReviewOptions {
  runId: string;
  sceneTrack: SceneTrack;
  brandContext?: ValidatorBrandContext;
  scriptFullSummary?: string;
  model?: string;
  apiKey?: string;
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export interface HolisticReviewResult {
  verdict: HolisticVerdict | null;
  error?: { type: string; message: string };
  durationMs: number;
  contactSheetPath?: string;
  scenesAnalyzed: number[];
}

/**
 * Corre el holistic review sobre TODAS las escenas del run. Construye un
 * contact sheet + manda a Sonnet 4-5 para análisis secuencial.
 *
 * Llamar UNA vez por run, después de que todas las scenes pasaron por el
 * VALIDATOR per-scene. Si el verdict global es 'needs-work' o
 * 'needs-major-rework', usar recommendedRegenerateIndices para disparar
 * regeneración targeted.
 */
export async function runHolisticReview(
  opts: HolisticReviewOptions,
): Promise<HolisticReviewResult> {
  const t0 = Date.now();
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = opts.model ?? HOLISTIC_MODEL;
  const logger = opts.logger;

  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    return {
      verdict: null,
      error: { type: 'no-api-key', message: 'ANTHROPIC_API_KEY no configurada' },
      durationMs: Date.now() - t0,
      scenesAnalyzed: [],
    };
  }

  const selected = selectScenesForContactSheet(opts.sceneTrack.scenes);
  const scenesAnalyzed = selected.map((s) => s.pickedIndex);

  const outDir = resolve(VALIDATOR_STORAGE_ABS, opts.runId);
  await mkdir(outDir, { recursive: true });
  const contactSheetPath = join(outDir, 'holistic-contact-sheet.png');

  const sheet = await buildContactSheet({
    scenes: selected,
    outputPath: contactSheetPath,
  });

  if (!sheet) {
    logger?.warn(
      { runId: opts.runId, entity: VALIDATOR_NAME },
      'validator-chat-ia-holistic:contact_sheet_build_failed',
    );
    return {
      verdict: null,
      error: { type: 'api-error', message: 'No se pudo construir contact sheet' },
      durationMs: Date.now() - t0,
      scenesAnalyzed,
    };
  }

  const sheetBuffer = await readFile(contactSheetPath);

  // Construir texto que mapea grid position → scene index
  const positionMap: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i]!;
    const row = Math.floor(i / sheet.gridCols);
    const col = i % sheet.gridCols;
    const sn = sel.scene;
    const sceneAny = sn as Scene & { narrativeBeat?: string; shotType?: string };
    positionMap.push(
      `  - Grid (col ${col}, row ${row}) = **Scene #${sel.pickedIndex}** · narrativeBeat=${sceneAny.narrativeBeat ?? '?'} · shotType=${sceneAny.shotType ?? '?'}\n    Narración: "${sn.text.slice(0, 120)}"`,
    );
  }

  const userText = [
    `# ${VALIDATOR_NAME} — Holistic Sequence Review`,
    ``,
    `Te muestro un contact sheet de **${selected.length} escenas** del video (de ${opts.sceneTrack.scenes.length} totales — sampleadas equitativamente si pasaban del límite).`,
    ``,
    `**Layout del grid:** ${sheet.gridCols} columnas × ${sheet.gridRows} filas, lectura izquierda-a-derecha, arriba-a-abajo.`,
    ``,
    `**Mapeo grid → scene:**`,
    positionMap.join('\n'),
    ``,
    opts.brandContext?.productName
      ? `**Producto:** ${opts.brandContext.productName}${opts.brandContext.productUsageForm ? ` (forma de uso: ${opts.brandContext.productUsageForm})` : ''}`
      : '',
    opts.brandContext?.styleSummary
      ? `**Estilo esperado:** ${opts.brandContext.styleSummary}`
      : '',
    ``,
    opts.scriptFullSummary
      ? `**Script completo del ad:**\n"${opts.scriptFullSummary.slice(0, 1500)}"`
      : '',
    ``,
    `---`,
    `Evaluá COMO SECUENCIA usando los criterios del system prompt. Devolvé SOLO el JSON.`,
  ]
    .filter(Boolean)
    .join('\n');

  // Una sola imagen + texto
  const content: ClaudeMessageContent[] = [
    ...buildImageMessageContent(sheetBuffer, userText, 'image/png'),
  ];

  // judgeRaw para no inyectar system context (lo controlamos nosotros)
  const result = await judgeRaw({
    apiKey,
    model,
    maxTokens: 3500,
    temperature: 0,
    timeoutMs: HOLISTIC_TIMEOUT_MS,
    system: HOLISTIC_SYSTEM_PROMPT,
    userContent: content,
    schema: HolisticVerdictSchema,
  });

  const durationMs = Date.now() - t0;
  if (result.isErr()) {
    logger?.warn(
      { runId: opts.runId, err: result.error.message, entity: VALIDATOR_NAME },
      'validator-chat-ia-holistic:api_error',
    );
    return {
      verdict: null,
      error: { type: result.error.type, message: result.error.message },
      durationMs,
      contactSheetPath,
      scenesAnalyzed,
    };
  }

  // Persistir el verdict para la UI
  try {
    await writeFile(
      join(outDir, 'holistic-verdict.json'),
      JSON.stringify(
        {
          runId: opts.runId,
          timestampIso: new Date().toISOString(),
          modelUsed: model,
          scenesAnalyzed,
          contactSheetPath,
          verdict: result.value,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch {
    // best-effort
  }

  logger?.info(
    {
      runId: opts.runId,
      globalVerdict: result.value.globalVerdict,
      scoresAvg:
        (result.value.scorePacing +
          result.value.scoreCharacterConsistency +
          result.value.scorePaletteCoherence +
          result.value.scoreNarrativeFlow +
          result.value.scoreHookStrength +
          result.value.scoreCtaStrength) /
        6,
      issuesCount: result.value.issues.length,
      regenerateCount: result.value.recommendedRegenerateIndices.length,
      durationMs,
      entity: VALIDATOR_NAME,
    },
    'validator-chat-ia-holistic:verdict',
  );

  return {
    verdict: result.value,
    durationMs,
    contactSheetPath,
    scenesAnalyzed,
  };
}

export async function readHolisticVerdict(
  runId: string,
): Promise<HolisticVerdict | null> {
  const path = resolve(VALIDATOR_STORAGE_ABS, runId, 'holistic-verdict.json');
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as { verdict?: HolisticVerdict };
    return parsed.verdict ?? null;
  } catch {
    return null;
  }
}
