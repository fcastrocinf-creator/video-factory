// POST /api/rip/[id]/build-preset
//
// Recibe un ripId con análisis completado y un brandId. Construye un PresetConfig
// dinámico derivado del análisis (estilo, narrador, paleta, hookType...) y lo
// persiste en packages/presets/learned-*.preset.json.
//
// Devuelve { presetId, displayName } para que el frontend lo pase al endpoint
// /rip o /scripts en el siguiente paso del flow.

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, rips } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { loadBrand } from '@/lib/brand-preset-loader';
import { AdAnalysisSchema } from '@video-factory/contracts';
import { buildAndPersistDynamicPreset } from '@/lib/dynamic-preset-builder';

export const runtime = 'nodejs';

const BodySchema = z.object({
  brandId: z.string().min(1),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const rip = (await db.select().from(rips).where(eq(rips.id, params.id)).limit(1))[0];
  if (!rip) {
    return NextResponse.json({ error: 'Rip no encontrado' }, { status: 404 });
  }
  if (rip.status !== 'analyzed' || !rip.analysisJson) {
    return NextResponse.json(
      { error: `Rip aún no analizado (status=${rip.status})` },
      { status: 409 },
    );
  }
  const analysisParsed = AdAnalysisSchema.safeParse(JSON.parse(rip.analysisJson));
  if (!analysisParsed.success) {
    return NextResponse.json(
      { error: `Análisis corrupto: ${analysisParsed.error.message.slice(0, 200)}` },
      { status: 500 },
    );
  }

  let brand;
  try {
    brand = await loadBrand(parsed.data.brandId);
  } catch (e) {
    return NextResponse.json(
      { error: `Brand no encontrado: ${(e as Error).message}` },
      { status: 404 },
    );
  }

  try {
    const { preset, presetId } = await buildAndPersistDynamicPreset({
      analysis: analysisParsed.data,
      brand,
      sourceFileName: rip.videoFileName,
    });
    return NextResponse.json({
      presetId,
      displayName: preset.displayName,
      category: preset.category?.displayName,
      format: preset.format?.displayName,
      estrategia: preset.estrategia,
      visualEngine: preset.visualEngine,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `build-preset failed: ${(e as Error).message.slice(0, 500)}` },
      { status: 500 },
    );
  }
}
