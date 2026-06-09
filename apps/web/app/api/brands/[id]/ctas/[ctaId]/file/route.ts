// GET /api/brands/[id]/ctas/[ctaId]/file  → sirve el binario del CTA (img o video).
// ?download=1 fuerza la descarga.

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { getCtaFile } from '@/lib/cta-store';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { id: string; ctaId: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const f = await getCtaFile(params.id, params.ctaId);
  if (!f) {
    return NextResponse.json({ error: 'CTA no encontrado' }, { status: 404 });
  }

  const url = new URL(req.url);
  const headers: Record<string, string> = {
    'content-type': f.contentType,
    'content-length': f.buffer.length.toString(),
    'cache-control': 'private, max-age=60',
  };
  if (url.searchParams.get('download') === '1') {
    headers['content-disposition'] = `attachment; filename="${params.ctaId}"`;
  }
  // TS strict: Web Response requiere Uint8Array<ArrayBuffer>; new Uint8Array(buffer) lo satisface.
  return new NextResponse(new Uint8Array(f.buffer), { headers });
}
