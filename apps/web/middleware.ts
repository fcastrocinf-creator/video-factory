import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, AUTH_COOKIE_VALUE } from '@/lib/auth';

export function middleware(req: NextRequest) {
  const cookie = req.cookies.get(AUTH_COOKIE);
  if (cookie?.value !== AUTH_COOKIE_VALUE) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// Protegemos /create/** y /runs/**. El index (/) es público (login).
export const config = {
  matcher: ['/create/:path*', '/runs/:path*'],
};
