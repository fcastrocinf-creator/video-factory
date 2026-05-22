import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, rips } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { loadBrand, loadPreset } from '@/lib/brand-preset-loader';
import { AdAnalysisSchema } from '@video-factory/contracts';
import { ripAd } from '@/lib/ad-ripper';

export const runtime = 'nodejs';
// Hot-reload marker: 2026-05-20-composite-fixes

const BodySchema = z.object({
  brandId: z.string().min(1),
  presetId: z.string().min(1),
  productId: z.string().nullable().optional(),
  targetLanguage: z.string().optional(),
  /**
   * 'high' activa el rip-fidelity-aligner: por cada escena del plan, loop
   * iterativo comparando contra keyframes del original hasta ≥95% similitud.
   * Más lento (~10-15 min) y más caro (~$2-3) pero genera imágenes mucho más
   * cercanas al estilo del original. 'fast' es el flujo histórico con image-gen-multi.
   */
  fidelityMode: z.enum(['fast', 'high']).optional().default('fast'),
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
    return NextResponse.json({ error: 'Análisis corrupto' }, { status: 500 });
  }

  let brand;
  let preset;
  try {
    [brand, preset] = await Promise.all([
      loadBrand(parsed.data.brandId),
      loadPreset(parsed.data.presetId),
    ]);
  } catch (e) {
    return NextResponse.json(
      { error: `Brand o preset no encontrado: ${(e as Error).message}` },
      { status: 404 },
    );
  }
  void preset; // validamos que existe, lo usa runPipeline internamente

  // Si el user pidió fidelidad alta, validamos que el archivo del video existe
  // realmente en disco. Si no (DB corruption, storage limpiado, etc.), fallamos
  // temprano con error útil en vez de dejar que ffmpeg crashee adentro del pipeline.
  let referenceVideoPath: string | null = null;
  if (parsed.data.fidelityMode === 'high') {
    if (!rip.videoPath) {
      return NextResponse.json(
        { error: 'Este rip no tiene videoPath en DB; no se puede usar fidelidad alta.' },
        { status: 409 },
      );
    }
    const { existsSync } = await import('node:fs');
    if (!existsSync(rip.videoPath)) {
      return NextResponse.json(
        {
          error: `El video original ya no está en disco (${rip.videoPath}). Usa modo "Rápido" o vuelve a subir el video.`,
        },
        { status: 410 },
      );
    }
    referenceVideoPath = rip.videoPath;
  }

  try {
    const result = await ripAd({
      analysis: analysisParsed.data,
      brand,
      presetId: parsed.data.presetId,
      productId: parsed.data.productId ?? null,
      targetLanguage: parsed.data.targetLanguage,
      referenceVideoPath,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message.slice(0, 500) },
      { status: 500 },
    );
  }
}
