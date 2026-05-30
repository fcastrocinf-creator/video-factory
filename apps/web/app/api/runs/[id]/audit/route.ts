// POST /api/runs/[id]/audit — re-auditoría profunda con Claude Sonnet 4-5.
//
// El preview-judge corre durante el pipeline con Claude Haiku (velocidad/costo).
// Haiku tiene limitaciones de visión que dejan pasar errores obvios (texto
// burned-in "9:16", pastillas vs gotas sublinguales, edad mismatch, etc.).
//
// Este endpoint re-evalúa TODAS las imágenes del run con Sonnet 4-5 (visión
// más profunda) usando el SYSTEM_PROMPT v2 estricto del judge, contexto cross-
// scene (las 2 anteriores), brandContext completo, y scene-plan global.
//
// Devuelve un audit report con: por scene → pass/fail + scores + issues +
// suggestions. La UI usa este report para mostrar tabla regenerable.
//
// Costo: ~$0.02-0.05 por scene con Sonnet → un audit completo de 50 scenes
// cuesta ~$1-2.5 USD. Latencia: ~5-8s por scene (concurrencia 5).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { judgeImage } from '@video-factory/block-preview-judge';
import { loadBrand, loadPreset } from '@/lib/brand-preset-loader';
import { SceneTrackSchema, type SceneTrack, type Scene } from '@video-factory/contracts';

export const runtime = 'nodejs';
export const maxDuration = 600; // 10 min cap — audit profundo puede tardar

// Sonnet 4-5 rate limit: 30k input tokens/min. Cada scene ~5-6k tokens
// (imagen + prompts). Concurrency 2 = ~12k tokens/segundo → seguro.
const CONCURRENCY = 2;
const MAX_RETRIES_429 = 3;
const AUDIT_MODEL = 'claude-sonnet-4-5'; // visión más profunda que Haiku

interface AuditSceneIssue {
  severity: 'minor' | 'major' | 'critical';
  category: string;
  description: string;
  suggestedSystemicPatch?: string;
}

interface AuditSceneResult {
  index: number;
  imagePath: string;
  imagePathRelative: string;
  pass: boolean;
  scoreVisual: number;
  scoreBrandFit: number;
  scoreHookStrength: number;
  scoreLogicalCoherence?: number;
  scoreViveness?: number;
  scoreContinuity?: number;
  issues: AuditSceneIssue[];
  suggestions: string[];
  rationale: string;
  // Si pass=false, qué tan crítico es regenerarla
  recommendRegenerate: boolean;
}

interface AuditReport {
  runId: string;
  modelUsed: string;
  totalScenes: number;
  scenesEvaluated: number;
  scenesPassed: number;
  scenesRecommendedRegenerate: number;
  criticalIssuesCount: number;
  majorIssuesCount: number;
  minorIssuesCount: number;
  perScene: AuditSceneResult[];
  elapsedSec: number;
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY no configurada' }, { status: 503 });
  }

  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row || !row.workDir) {
    return NextResponse.json({ error: 'Run no encontrado o sin workDir' }, { status: 404 });
  }

  // Leer scene-plan.json para tener contexto completo
  const scenePlanPath = resolve(row.workDir, 'scene-plan.json');
  if (!existsSync(scenePlanPath)) {
    return NextResponse.json({ error: 'scene-plan.json no existe' }, { status: 404 });
  }
  let sceneTrack: SceneTrack;
  try {
    const raw = JSON.parse(await readFile(scenePlanPath, 'utf-8'));
    const parsed = SceneTrackSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `scene-plan.json inválido: ${parsed.error.message.slice(0, 200)}` },
        { status: 500 },
      );
    }
    sceneTrack = parsed.data;
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo leer scene-plan: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Cargar brand + preset para contexto
  let brandContext: {
    brandId?: string;
    productName?: string;
    productDescription?: string;
    productUsageForm?: string;
    palette?: string[];
    styleSummary?: string;
    language?: string;
  } = {};
  try {
    if (row.brandId) {
      const brand = await loadBrand(row.brandId);
      brandContext.brandId = brand.id;
      brandContext.language = brand.language?.split('-')[0] ?? 'es';
      if (row.productId) {
        const product = brand.products.find((p) => p.id === row.productId);
        if (product) {
          brandContext.productName = product.name;
          brandContext.productDescription = product.description;
          // Heurística: si la description menciona "sublingual" o "bajo la lengua" → sublingual
          if (/sublingual|bajo la lengua|gotero|gotas/i.test(product.description ?? '')) {
            brandContext.productUsageForm = 'sublingual';
          } else if (/crema|t[oó]pico|aplicar/i.test(product.description ?? '')) {
            brandContext.productUsageForm = 'topical';
          } else if (/spray|inhal/i.test(product.description ?? '')) {
            brandContext.productUsageForm = 'spray';
          } else if (/pastilla|c[aá]psula|tableta|p[ií]ldora/i.test(product.description ?? '')) {
            brandContext.productUsageForm = 'oral';
          }
        }
      }
    }
    if (row.presetId) {
      const preset = await loadPreset(row.presetId);
      brandContext.styleSummary =
        [preset.format?.displayName, preset.style?.displayName].filter(Boolean).join(' · ') || undefined;
    }
  } catch {
    // best-effort — sin brand/preset el audit aún funciona pero con menos contexto
  }

  const scriptFullSummary = sceneTrack.scenes.map((s) => s.text).join(' ').slice(0, 2000);

  // Auditar scenes en paralelo (concurrency 5)
  const t0 = Date.now();
  const results: (AuditSceneResult | null)[] = new Array(sceneTrack.scenes.length).fill(null);
  const queue = sceneTrack.scenes.map((s, i) => ({ scene: s, idx: i }));

  async function auditOne(scene: Scene, idx: number): Promise<void> {
    if (!scene.imagePath || !existsSync(scene.imagePath)) {
      results[idx] = {
        index: scene.index,
        imagePath: scene.imagePath ?? '',
        imagePathRelative: scene.imagePath ? scene.imagePath.split(/[\\/]/).pop()! : '(missing)',
        pass: false,
        scoreVisual: 0,
        scoreBrandFit: 0,
        scoreHookStrength: 0,
        issues: [
          {
            severity: 'critical',
            category: 'subject',
            description: 'Imagen no existe en disco',
          },
        ],
        suggestions: ['Regenerar la imagen desde cero'],
        rationale: 'Imagen faltante',
        recommendRegenerate: true,
      };
      return;
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = await readFile(scene.imagePath);
    } catch {
      results[idx] = null;
      return;
    }

    // Contexto cross-scene (2 anteriores)
    const prevScenesContext = sceneTrack.scenes
      .slice(Math.max(0, idx - 2), idx)
      .map((s: Scene) => ({
        index: s.index,
        visualDescription: (s.imagePrompt ?? '').slice(0, 200),
        narration: (s.text ?? '').slice(0, 100),
      }));

    // Retry con backoff para rate limit 429 (Sonnet 4-5 tiene 30k tokens/min)
    let judgeResult: Awaited<ReturnType<typeof judgeImage>> | null = null;
    let lastError: { type: string; message: string; detail?: string } | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES_429; attempt++) {
      const result = await judgeImage(
        {
          imageBuffer,
          imageMimeType: 'image/png',
          prompt: scene.imagePrompt ?? scene.text,
          sceneNarration: scene.text,
          brandContext,
          expectedStyle: brandContext.styleSummary,
          scenePosition: {
            index: scene.index,
            total: sceneTrack.scenes.length,
            shotType: (scene as { shotType?: string }).shotType,
          },
          prevScenesContext: prevScenesContext.length > 0 ? prevScenesContext : undefined,
          scriptFullSummary,
        },
        {
          model: AUDIT_MODEL, // 🎯 Sonnet 4-5 para visión profunda
          maxTokens: 4096,
          timeoutMs: 90_000,
        },
      );
      if (result.isOk()) {
        judgeResult = result;
        break;
      }
      lastError = result.error;
      // Si es rate limit (429), retry con backoff. Sino, fail inmediato.
      const isRateLimit =
        result.error.message.includes('429') ||
        result.error.message.toLowerCase().includes('rate limit');
      if (!isRateLimit) {
        judgeResult = result;
        break;
      }
      if (attempt < MAX_RETRIES_429) {
        // Backoff: 5s, 10s, 20s
        const backoffMs = 5_000 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        judgeResult = result;
      }
    }
    if (!judgeResult) {
      // Defensive — no debería ocurrir
      judgeResult = { isErr: () => true, isOk: () => false, error: lastError ?? { type: 'api-error', message: 'Unknown' } } as unknown as Awaited<ReturnType<typeof judgeImage>>;
    }

    if (judgeResult.isErr()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[audit] scene ${scene.index} judge failed: type=${judgeResult.error.type} message=${judgeResult.error.message.slice(0, 200)} detail=${judgeResult.error.detail?.slice(0, 400) ?? '(none)'}`,
      );
      results[idx] = {
        index: scene.index,
        imagePath: scene.imagePath,
        imagePathRelative: scene.imagePath.split(/[\\/]/).pop()!,
        pass: false,
        scoreVisual: 0,
        scoreBrandFit: 0,
        scoreHookStrength: 0,
        issues: [
          {
            severity: 'critical',
            category: 'other',
            description: `Audit fallo: ${judgeResult.error.message.slice(0, 200)} | detail: ${judgeResult.error.detail?.slice(0, 200) ?? '(none)'}`,
          },
        ],
        suggestions: [],
        rationale: 'Judge no pudo evaluar la imagen',
        recommendRegenerate: false,
      };
      return;
    }

    const r = judgeResult.value as typeof judgeResult.value & {
      scoreLogicalCoherence?: number;
      scoreViveness?: number;
      scoreContinuity?: number;
    };
    const hasCritical = r.issues.some((i: { severity: string }) => i.severity === 'critical');
    const recommendRegenerate = !r.pass || hasCritical;

    results[idx] = {
      index: scene.index,
      imagePath: scene.imagePath,
      imagePathRelative: scene.imagePath.split(/[\\/]/).pop()!,
      pass: r.pass,
      scoreVisual: r.scoreVisual,
      scoreBrandFit: r.scoreBrandFit,
      scoreHookStrength: r.scoreHookStrength,
      scoreLogicalCoherence: r.scoreLogicalCoherence,
      scoreViveness: r.scoreViveness,
      scoreContinuity: r.scoreContinuity,
      issues: r.issues.map((i: { severity: 'minor' | 'major' | 'critical'; category: string; description: string }) => ({
        severity: i.severity,
        category: i.category,
        description: i.description,
        suggestedSystemicPatch: (i as { suggestedSystemicPatch?: string }).suggestedSystemicPatch,
      })),
      suggestions: r.suggestions,
      rationale: r.rationale,
      recommendRegenerate,
    };
  }

  // Workers paralelos
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      await auditOne(item.scene, item.idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sceneTrack.scenes.length) }, () => worker()),
  );

  const perScene = results.filter((r): r is AuditSceneResult => r !== null);
  const report: AuditReport = {
    runId: params.id,
    modelUsed: AUDIT_MODEL,
    totalScenes: sceneTrack.scenes.length,
    scenesEvaluated: perScene.length,
    scenesPassed: perScene.filter((r) => r.pass).length,
    scenesRecommendedRegenerate: perScene.filter((r) => r.recommendRegenerate).length,
    criticalIssuesCount: perScene.reduce(
      (acc, r) => acc + r.issues.filter((i) => i.severity === 'critical').length,
      0,
    ),
    majorIssuesCount: perScene.reduce(
      (acc, r) => acc + r.issues.filter((i) => i.severity === 'major').length,
      0,
    ),
    minorIssuesCount: perScene.reduce(
      (acc, r) => acc + r.issues.filter((i) => i.severity === 'minor').length,
      0,
    ),
    perScene,
    elapsedSec: (Date.now() - t0) / 1000,
  };

  return NextResponse.json(report);
}
