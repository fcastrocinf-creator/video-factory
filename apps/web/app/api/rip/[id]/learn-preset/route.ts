// POST /api/rip/[id]/learn-preset
//
// Dispara `runPresetLearningLoop` sobre el VIDEO ORIGINAL del rip. Genera un
// preset auto-aprendido + validado iterativamente hasta lograr targetScore (default
// 95%) o agotar maxIterations (default 4).
//
// Diseñado para invocarse:
//   1) MANUALMENTE desde la UI del rip ("🧠 Aprender estilo al 95%")
//   2) AUTOMÁTICAMENTE al finalizar un rip (hook en pipeline.ts)
//
// El preset resultante queda en `packages/presets/pending/learned-auto-*.preset.json`.
// El reporte de iteraciones queda al lado en `*.iterations.json` con scores
// individuales por iter (style/palette/composition/character/mood) + hints.
//
// Costo: ~$0.40-1.20 con target 95% (más iter típicas que con target 80%).
// Latencia: ~90-240s (4 iters × ~30-60s c/u).

import { NextResponse, type NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, rips } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { runPresetLearningLoop } from '@/lib/preset-learning-loop';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min cap — el loop puede tardar

interface RouteParams {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY no configurada' }, { status: 503 });
  }

  const rip = (await db.select().from(rips).where(eq(rips.id, params.id)).limit(1))[0];
  if (!rip) {
    return NextResponse.json({ error: 'Rip no encontrado' }, { status: 404 });
  }
  if (!rip.videoPath || !existsSync(rip.videoPath)) {
    return NextResponse.json(
      {
        error: `Video original no encontrado en disco (${rip.videoPath ?? 'sin path en DB'}). Re-subí el video.`,
      },
      { status: 410 },
    );
  }

  // Body opcional: { targetScore?, maxIterations?, displayNameOverride? }
  let body: { targetScore?: number; maxIterations?: number; displayNameOverride?: string } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // body opcional
  }

  // Bounds defensivos: targetScore 50-99, maxIterations 1-10. Sin esto, body
  // con valores absurdos puede causar loops infinitos o jobs sin sentido.
  const clamp = (v: number | undefined, def: number, min: number, max: number) =>
    Math.max(min, Math.min(max, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def));
  const targetScore = clamp(body.targetScore, 95, 50, 99);
  const maxIterations = clamp(body.maxIterations, 4, 1, 10);
  // displayNameOverride: max 200 chars para evitar prompt injection / DB bloat
  const displayNameOverride =
    typeof body.displayNameOverride === 'string' && body.displayNameOverride.length <= 200
      ? body.displayNameOverride
      : undefined;

  try {
    const result = await runPresetLearningLoop({
      videoPath: rip.videoPath,
      displayNameOverride,
      // Default target 95% según la regla del owner: aprender prompts hasta
      // coincidencia muy similar. Configurable por body.
      targetScore,
      maxIterations,
    });
    return NextResponse.json({
      ok: true,
      presetId: result.preset.id,
      displayName: result.preset.displayName,
      presetFilePath: result.presetFilePath,
      approved: result.approved,
      exhausted: result.exhausted,
      finalScore: result.finalScore,
      iterationsRun: result.iterationsRun,
      iterations: result.iterations.map((it) => ({
        iteration: it.iteration,
        score: it.score,
        details: it.details,
        hint: it.hint,
      })),
      elapsedSec: result.elapsedSec,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Loop falló: ${msg.slice(0, 500)}` }, { status: 500 });
  }
}
