// GET /api/admin/kb → agregados de la Base de Conocimiento + eventos recientes.
// Read-only (la recolección es automática en otro lado). Para la vista en /admin.
// Query params opcionales: ?subsistema= ?tipo= ?vault= ?limit= (default 50, máx 200).

import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { query, kbStats } from '@/lib/kb/query';
import type { KbSubsistema, KbTipo } from '@/lib/kb/record';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const url = new URL(req.url);
  const subsistema = url.searchParams.get('subsistema') || undefined;
  const tipo = url.searchParams.get('tipo') || undefined;
  const vaultRaw = url.searchParams.get('vault') || undefined;
  const vault = vaultRaw === 'dev' || vaultRaw === 'producto' ? vaultRaw : undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;

  const [stats, eventos] = await Promise.all([
    kbStats(),
    query({
      subsistema: subsistema as KbSubsistema | undefined,
      tipo: tipo as KbTipo | undefined,
      vault,
      limit,
    }),
  ]);
  return NextResponse.json({ stats, eventos });
}
