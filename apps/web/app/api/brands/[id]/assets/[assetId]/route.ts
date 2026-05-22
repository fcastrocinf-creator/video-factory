import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { deleteBrandAsset } from '@/lib/brand-ingredients-store';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; assetId: string } },
) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    const updated = await deleteBrandAsset(params.id, params.assetId);
    return NextResponse.json({ assets: updated.ingredients.assets });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
