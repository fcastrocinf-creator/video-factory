import { cookies } from 'next/headers';

export const AUTH_COOKIE = 'app_auth';
export const AUTH_COOKIE_VALUE = 'valid';

export function checkPassword(submitted: string): boolean {
  const expected = process.env['APP_PASSWORD'];
  if (!expected) {
    throw new Error('APP_PASSWORD no está configurada en .env');
  }
  return submitted === expected;
}

export function setAuthCookie(): void {
  cookies().set(AUTH_COOKIE, AUTH_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 días
  });
}

export function clearAuthCookie(): void {
  cookies().delete(AUTH_COOKIE);
}

export function isAuthenticated(): boolean {
  return cookies().get(AUTH_COOKIE)?.value === AUTH_COOKIE_VALUE;
}
