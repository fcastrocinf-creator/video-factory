import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { moveToTrash, purgeRunPermanently, restoreFromTrash } from '@/lib/runs-repository';

export const runtime = 'nodejs';

// POST /api/runs/[id]/trash → soft-delete (mueve a papelera)
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  await moveToTrash(params.id);
  return NextResponse.json({ ok: true, retentionDays: 30 });
}

// PUT /api/runs/[id]/trash → restore (saca de papelera)
export async function PUT(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  await restoreFromTrash(params.id);
  return NextResponse.json({ ok: true });
}

// DELETE /api/runs/[id]/trash → purge permanente (borra DB + workDir)
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  await purgeRunPermanently(params.id);
  return NextResponse.json({ ok: true });
}
