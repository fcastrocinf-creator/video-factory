import { NextResponse } from 'next/server';
import { checkPassword, setAuthCookie } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password !== 'string') {
      return NextResponse.json({ error: 'Password requerido' }, { status: 400 });
    }
    if (!checkPassword(body.password)) {
      return NextResponse.json({ error: 'Contraseña incorrecta' }, { status: 401 });
    }
    setAuthCookie();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
