import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, AUTH_COOKIE_VALUE } from '@/lib/auth';

export function middleware(req: NextRequest) {
  const cookie = req.cookies.get(AUTH_COOKIE);
  if (cookie?.value !== AUTH_COOKIE_VALUE) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }
  // v3.2 (29-may-2026): en dev forzamos no-cache para que el browser SIEMPRE
  // pida la versión fresca de la página y JS. Sin esto, después de un cambio
  // de código, hace falta Ctrl+F5 manual para que el owner vea la UI nueva —
  // experiencia frustrante. En producción Next.js maneja cache headers solo.
  const res = NextResponse.next();
  if (process.env.NODE_ENV !== 'production') {
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.headers.set('Pragma', 'no-cache');
    res.headers.set('Expires', '0');
  }
  return res;
}

// Protegemos /create/**, /runs/**, /rip/**, /admin/** y /aprendizaje/**.
// El index (/) es público (login).
// NOTA: /brands también debería protegerse (bug pre-existente fuera del scope).
export const config = {
  matcher: [
    '/create/:path*',
    '/runs/:path*',
    '/rip/:path*',
    '/admin/:path*',
    '/aprendizaje/:path*',
  ],
};
