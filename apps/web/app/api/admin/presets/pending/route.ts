// GET /api/admin/presets/pending → lista de presets aprendidos esperando aprobación.

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { listPendingPresets } from '@/lib/admin-presets-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const pending = await listPendingPresets();
  return NextResponse.json({ pending });
}
