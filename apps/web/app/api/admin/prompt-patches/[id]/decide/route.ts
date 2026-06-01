// POST /api/admin/prompt-patches/[id]/decide
//
// Body: { action: 'approve' | 'reject' }
//
// Si approve: aplica el patch al archivo source y marca status='applied'.
// Si reject:  marca status='rejected'.

import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { applyPatch, rejectPatch } from '@/lib/prompt-evolution';
import { logSystemEvent } from '@/lib/system-log';

export const runtime = 'nodejs';

interface RouteParams {
  params: { id: string };
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  if (body.action !== 'approve' && body.action !== 'reject') {
    return NextResponse.json(
      { error: 'action debe ser "approve" o "reject"' },
      { status: 400 },
    );
  }

  if (body.action === 'approve') {
    const result = await applyPatch(params.id);
    void logSystemEvent({
      kind: 'config-changed',
      data: {
        patchId: params.id,
        action: 'approved-applied',
        success: result.applied,
        targetFilePath: result.updatedFilePath,
        error: result.error,
      },
      summary: `Prompt patch ${params.id.slice(0, 8)} APROBADO ${result.applied ? '+ aplicado a ' + (result.updatedFilePath?.split(/[\\/]/).pop() ?? '?') : 'pero apply falló: ' + result.error}`,
    });
    if (!result.applied) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      action: 'approve-applied',
      updatedFilePath: result.updatedFilePath,
      reminder: 'Reinicia el dev server para que el cambio surta efecto. Considerá commitear el patch.',
    });
  }

  // reject
  const result = await rejectPatch(params.id);
  void logSystemEvent({
    kind: 'config-changed',
    data: { patchId: params.id, action: 'rejected', success: result.rejected, error: result.error },
    summary: `Prompt patch ${params.id.slice(0, 8)} RECHAZADO`,
  });
  if (!result.rejected) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true, action: 'reject' });
}
