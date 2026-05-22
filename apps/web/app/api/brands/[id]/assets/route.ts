import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { saveBrandAsset } from '@/lib/brand-ingredients-store';

export const runtime = 'nodejs';

const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const VALID_KINDS = ['product-shot', 'packaging', 'mockup', 'lifestyle', 'icon', 'other'] as const;
type AssetKind = (typeof VALID_KINDS)[number];

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
    return NextResponse.json({ error: 'Archivo requerido' }, { status: 400 });
  }
  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json({ error: `Tipo no soportado: ${file.type}` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Asset > 10 MB (${(file.size / 1024 / 1024).toFixed(1)} MB)` },
      { status: 413 },
    );
  }

  const rawKind = (formData.get('kind') as string | null) ?? 'other';
  const kind: AssetKind = (VALID_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as AssetKind)
    : 'other';
  const description = ((formData.get('description') as string | null) ?? '').trim();
  if (!description || description.length < 5) {
    return NextResponse.json(
      { error: 'description requerida (>= 5 caracteres) para que la IA reconozca el asset' },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const updated = await saveBrandAsset({
    brandId: params.id,
    buffer,
    contentType: file.type,
    kind,
    description,
  });

  return NextResponse.json({ assets: updated.ingredients.assets });
}
