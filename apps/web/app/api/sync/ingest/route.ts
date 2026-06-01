// POST /api/sync/ingest — RECEPTOR CENTRAL del buzón de aprendizaje.
//
// Recibe los eventos del KB que cada instalación sincroniza (cliente: sync.ts).
// Auth por bearer token: el .env del receptor debe tener VF_SYNC_INGEST_KEY, y el
// cliente manda ese mismo valor como `Authorization: Bearer <token>`
// (VF_LEARNING_SYNC_KEY en su .env). Si el receptor no está configurado → 503.
//
// NO expone nada; solo almacena. El middleware no cubre /api/*, así que esta
// ruta se auto-chequea con el token.

import { NextResponse, type NextRequest } from 'next/server';
import { ingestEventos } from '@/lib/kb/central-store';
import type { KbEvento } from '@/lib/kb/record';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env['VF_SYNC_INGEST_KEY'];
  if (!expected || expected.trim().length === 0) {
    return NextResponse.json(
      { error: 'Receptor no configurado (falta VF_SYNC_INGEST_KEY en el .env).' },
      { status: 503 },
    );
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token !== expected) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  let body: { eventos?: unknown; instalacion?: unknown; enviadoEn?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const instalacion =
    typeof body.instalacion === 'string' && body.instalacion.trim().length > 0
      ? body.instalacion
      : 'unknown';
  const eventos = Array.isArray(body.eventos) ? (body.eventos as KbEvento[]) : [];
  const recibidoEn = new Date().toISOString();

  try {
    const received = await ingestEventos(instalacion, eventos, recibidoEn);
    return NextResponse.json({ ok: true, received, instalacion });
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo almacenar: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
