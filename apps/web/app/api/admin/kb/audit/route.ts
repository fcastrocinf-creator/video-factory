// POST /api/admin/kb/audit  → corre deepAudit ON-DEMAND (paga API; solo el owner lo dispara).
// GET  /api/admin/kb/audit  → lista los hallazgos persistidos (findings.jsonl).
//
// Body POST (opcional): { subsistemas?: string[], depth?: 'rapido'|'profundo',
//                         force?: boolean, maxVerificaciones?: number }

import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { deepAudit } from '@/lib/kb/deep-audit';
import { listHallazgos, readLastAuditReport, type HallazgoEstado } from '@/lib/kb/findings';
import { getAutoAuditStatus } from '@/lib/kb/auto-audit';

export const runtime = 'nodejs';
// Una auditoría profunda (varias llamadas a Claude) puede tardar minutos.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const url = new URL(req.url);
  const subsistema = url.searchParams.get('subsistema') || undefined;
  const estado = (url.searchParams.get('estado') as HallazgoEstado | null) || undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
  const [hallazgos, lastReport, auto] = await Promise.all([
    listHallazgos({ subsistema, estado, limit }),
    readLastAuditReport(),
    getAutoAuditStatus(),
  ]);
  return NextResponse.json({ hallazgos, lastReport, auto });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY no configurada' }, { status: 503 });
  }

  let body: {
    subsistemas?: unknown;
    depth?: unknown;
    force?: unknown;
    maxVerificaciones?: unknown;
  } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // body opcional
  }

  const subsistemas = Array.isArray(body.subsistemas)
    ? body.subsistemas.filter((s): s is string => typeof s === 'string').slice(0, 12)
    : undefined;
  const depth = body.depth === 'profundo' ? 'profundo' : 'rapido';
  const force = body.force === true;
  const maxVerificaciones =
    typeof body.maxVerificaciones === 'number' && Number.isFinite(body.maxVerificaciones)
      ? Math.max(0, Math.min(20, Math.floor(body.maxVerificaciones)))
      : undefined;

  try {
    const report = await deepAudit({ subsistemas, depth, force, maxVerificaciones });
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: `deepAudit falló: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
