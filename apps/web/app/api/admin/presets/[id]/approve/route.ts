// POST /api/admin/presets/[id]/approve → mueve el preset de pending/ a PRESETS_DIR.

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { approvePendingPreset } from '@/lib/admin-presets-store';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    const approved = await approvePendingPreset(params.id);
    return NextResponse.json({ preset: approved });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /no encontrado/i.test(msg) ? 404 : /ya existe/i.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
