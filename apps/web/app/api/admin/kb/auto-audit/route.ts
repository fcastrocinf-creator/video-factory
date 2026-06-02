// POST /api/admin/kb/auto-audit  → enciende/apaga el análisis automático (botón).
// Body: { enabled: boolean }. Persistente (storage/kb/auto-audit-config.json).
import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { setAutoAuditEnabled, getAutoAuditStatus } from '@/lib/kb/auto-audit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  let body: { enabled?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // body inválido
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Falta "enabled" (boolean)' }, { status: 400 });
  }
  await setAutoAuditEnabled(body.enabled);
  return NextResponse.json({ ok: true, auto: await getAutoAuditStatus() });
}
