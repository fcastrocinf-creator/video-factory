// DELETE /api/brands/[id]/ctas/[ctaId]  → borra un CTA de la marca

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { deleteCta } from '@/lib/cta-store';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; ctaId: string } },
) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const ctas = await deleteCta(params.id, params.ctaId);
  return NextResponse.json({ ctas });
}
