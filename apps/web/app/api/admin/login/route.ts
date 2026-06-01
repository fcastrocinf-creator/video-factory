// POST /api/admin/login — verifica la ADMIN_PASSWORD y setea la cookie de admin.
//
// Está EXENTO del gate de admin del middleware (no puede exigir la cookie que él
// mismo crea). Pero sí requiere estar logueado a la app (la pantalla de login de
// admin vive detrás del login normal). No expone la clave; solo compara.

import { NextResponse } from 'next/server';
import {
  isAuthenticated,
  isAdminConfigured,
  checkAdminPassword,
  setAdminCookie,
} from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ ok: false, error: 'No autenticado' }, { status: 401 });
  }
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'ADMIN_PASSWORD no está configurada en el .env del servidor.' },
      { status: 503 },
    );
  }

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!checkAdminPassword(password)) {
    return NextResponse.json({ ok: false, error: 'Clave de admin incorrecta' }, { status: 401 });
  }

  setAdminCookie();
  return NextResponse.json({ ok: true });
}
