import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { saveBrandLogo } from '@/lib/brand-ingredients-store';

export const runtime = 'nodejs';

const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'FormData inválido' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'Archivo requerido en campo "file"' }, { status: 400 });
  }
  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json({ error: `Tipo no soportado: ${file.type}` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Archivo demasiado grande (${(file.size / 1024 / 1024).toFixed(1)} MB, máx 5 MB)` },
      { status: 413 },
    );
  }

  const description = (formData.get('description') as string | null)?.trim() || undefined;
  const placement = (formData.get('placement') as string | null) || undefined;
  const validPlacements = ['last-scene', 'all-scenes', 'product-scenes', 'never'];
  const placementValid = placement && validPlacements.includes(placement)
    ? (placement as 'last-scene' | 'all-scenes' | 'product-scenes' | 'never')
    : undefined;

  const buffer = Buffer.from(await file.arrayBuffer());
  const updated = await saveBrandLogo({
    brandId: params.id,
    buffer,
    contentType: file.type,
    description,
    placement: placementValid,
  });

  return NextResponse.json({
    logoPath: updated.ingredients.logoPath,
    description: updated.ingredients.logoDescription,
    placement: updated.ingredients.logoPlacement,
  });
}
