// GET  /api/brands/[id]/ctas       → lista los CTAs de la marca
// POST /api/brands/[id]/ctas       → sube un CTA (imagen o video) — multipart

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { listCtas, saveCta, ACCEPTED_CTA_TYPES } from '@/lib/cta-store';

export const runtime = 'nodejs';

const ACCEPTED = new Set(ACCEPTED_CTA_TYPES);
const MAX_BYTES = 60 * 1024 * 1024; // 60 MB (los videos de cierre pesan más que un asset)

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const ctas = await listCtas(params.id);
  return NextResponse.json({ ctas });
}

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
    return NextResponse.json(
      { error: `Tipo no soportado: ${file.type}. Usa PNG/JPG/WEBP o MP4/WEBM/MOV.` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Archivo > 60 MB (${(file.size / 1024 / 1024).toFixed(1)} MB)` },
      { status: 413 },
    );
  }

  const label = ((formData.get('label') as string | null) ?? '').trim();
  const buffer = Buffer.from(await file.arrayBuffer());
  const cta = await saveCta({ brandId: params.id, buffer, contentType: file.type, label });
  return NextResponse.json({ cta });
}
