import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, rips } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { loadBrand } from '@/lib/brand-preset-loader';
import { AdAnalysisSchema, ScriptProposalSchema } from '@video-factory/contracts';
import { refineScript } from '@/lib/script-suggester';

export const runtime = 'nodejs';

const BodySchema = z.object({
  originalProposal: ScriptProposalSchema,
  feedback: z.string().min(3),
  brandId: z.string().min(1),
  productId: z.string().nullable().optional(),
  targetLanguage: z.string().optional(),
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
  try {
    brand = await loadBrand(parsed.data.brandId);
  } catch {
    return NextResponse.json({ error: 'Brand no encontrado' }, { status: 404 });
  }
  const product = parsed.data.productId
    ? brand.products.find((p) => p.id === parsed.data.productId)
    : brand.products[0];

  try {
    const refined = await refineScript({
      originalProposal: parsed.data.originalProposal,
      feedback: parsed.data.feedback,
      analysis: analysisParsed.data,
      brand,
      product,
      targetLanguage: parsed.data.targetLanguage,
    });
    return NextResponse.json({ proposal: refined });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message.slice(0, 500) },
      { status: 500 },
    );
  }
}
