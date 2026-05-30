// POST /api/training/[id]/auto-learn
//
// M7 Pieza B v1 — endpoint: invoca autoLearnPresetFromVideo() para que el frontend
// pueda generar un preset desde un video con UN SOLO click.
//
// El video debe estar previamente subido (existe en storage/training/{id}/source.mp4
// o similar). Este endpoint:
//   1. Localiza el .mp4 del training
//   2. Llama a autoLearnPresetFromVideo
//   3. Devuelve { presetId, presetFilePath, understandingFilePath, executiveSummary }
//
// Costo esperado: ~$0.05. Latencia: ~15-25s.

import { NextResponse, type NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { autoLearnPresetFromVideo } from '@/lib/auto-learn-preset';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

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

  // Buscar el video en posibles paths del training storage
  const candidates = [
    resolve(process.cwd(), '..', '..', 'storage', 'training', trainingId, 'source.mp4'),
    resolve(process.cwd(), 'storage', 'training', trainingId, 'source.mp4'),
    resolve(process.cwd(), '..', '..', 'storage', 'training', trainingId, 'video.mp4'),
    resolve(process.cwd(), 'storage', 'training', trainingId, 'video.mp4'),
    // También buscar en storage/rips si el id corresponde a un rip
    resolve(process.cwd(), '..', '..', 'storage', 'rips', trainingId, 'source.mp4'),
    resolve(process.cwd(), 'storage', 'rips', trainingId, 'source.mp4'),
  ];
  const videoPath = candidates.find((p) => existsSync(p));
  if (!videoPath) {
    return NextResponse.json(
      {
        error: `Video no encontrado para training ${trainingId}`,
        searchedPaths: candidates,
      },
      { status: 404 },
    );
  }

  // Body opcional: { displayNameOverride?, model? }
  let body: { displayNameOverride?: string; model?: string } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // body opcional — ignorar JSON parse errors
  }

  try {
    const result = await autoLearnPresetFromVideo({
      videoPath,
      displayNameOverride: body.displayNameOverride,
      brandIdForContext: trainingId, // informativo
      model: body.model,
      persistUnderstanding: true,
    });
    return NextResponse.json({
      ok: true,
      presetId: result.presetId,
      displayName: result.preset.displayName,
      presetFilePath: result.presetFilePath,
      understandingFilePath: result.understandingFilePath,
      executiveSummary: result.understanding.executiveSummary,
      styleId: result.understanding.styleId,
      hookType: result.understanding.hookType,
      palette: result.understanding.palette,
      sceneCount: result.understanding.scenes.length,
      modelUsed: result.modelUsed,
      elapsedSec: result.elapsedSec,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `Auto-learn falló: ${msg.slice(0, 500)}` },
      { status: 500 },
    );
  }
}
