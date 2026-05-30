// POST /api/training/[id]/auto-learn-iterative
//
// M7-B v2 — endpoint del LOOP ITERATIVO de auto-aprendizaje de presets.
// A diferencia del one-shot `/auto-learn`, este corre el ciclo
// understand→generar→comparar→refinar→repetir hasta lograr `targetScore` o
// agotar `maxIterations`.
//
// Body opcional:
//   { displayNameOverride?, targetScore? (default 80), maxIterations? (default 3), model? }
//
// Costo esperado: ~$0.30-0.80 (3 iteraciones × generación + comparación + refine).
// Latencia: ~60-180s.

import { NextResponse, type NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPresetLearningLoop } from '@/lib/preset-learning-loop';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';
// El loop iterativo puede tardar 60-240s. Sin esto, en Vercel default 10s corta.
export const maxDuration = 300;

interface RouteParams {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  if (!process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY no configurada' },
      { status: 503 },
    );
  }

  const trainingId = params.id;

  // Buscar el video en los mismos paths que /auto-learn
  const candidates = [
    resolve(process.cwd(), '..', '..', 'storage', 'training', trainingId, 'source.mp4'),
    resolve(process.cwd(), 'storage', 'training', trainingId, 'source.mp4'),
    resolve(process.cwd(), '..', '..', 'storage', 'training', trainingId, 'video.mp4'),
    resolve(process.cwd(), 'storage', 'training', trainingId, 'video.mp4'),
    resolve(process.cwd(), '..', '..', 'storage', 'rips', trainingId, 'source.mp4'),
    resolve(process.cwd(), 'storage', 'rips', trainingId, 'source.mp4'),
  ];
  const videoPath = candidates.find((p) => existsSync(p));
  if (!videoPath) {
    return NextResponse.json(
      { error: `Video no encontrado para training ${trainingId}`, searchedPaths: candidates },
      { status: 404 },
    );
  }

  let body: {
    displayNameOverride?: string;
    targetScore?: number;
    maxIterations?: number;
    model?: string;
  } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // body opcional
  }

  // Bounds defensivos (mismos que el endpoint del rip — consistencia)
  const clamp = (v: number | undefined, def: number, min: number, max: number) =>
    Math.max(min, Math.min(max, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def));
  const targetScore = clamp(body.targetScore, 95, 50, 99);
  const maxIterations = clamp(body.maxIterations, 4, 1, 10);
  const displayNameOverride =
    typeof body.displayNameOverride === 'string' && body.displayNameOverride.length <= 200
      ? body.displayNameOverride
      : undefined;
  const model =
    typeof body.model === 'string' && /^claude-(haiku|sonnet|opus)-[\d.-]+$/.test(body.model)
      ? body.model
      : undefined;

  try {
    const result = await runPresetLearningLoop({
      videoPath,
      displayNameOverride,
      // Default 95% según requirement del owner. Consistente con el hook
      // del rip y del training-upload (todos disparan loop al 95%).
      targetScore,
      maxIterations,
      model,
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
    return NextResponse.json(
      { error: `Auto-learn iterativo falló: ${msg.slice(0, 500)}` },
      { status: 500 },
    );
  }
}
