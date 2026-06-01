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

// ─── Acceso al ADMIN: clave separada (ADMIN_PASSWORD) ────────────────────────
// El admin NO se abre solo con estar logueado a la app: requiere una SEGUNDA
// clave (ADMIN_PASSWORD), distinta de APP_PASSWORD. Así, aunque un empleado
// entre a la app, no entra al admin sin esa clave. Es un gate real (credencial),
// no un flag de config. Protege la página /admin Y todos los endpoints /api/admin.

export const ADMIN_COOKIE = 'admin_auth';
export const ADMIN_COOKIE_VALUE = 'valid';

/** True si hay una ADMIN_PASSWORD configurada (no vacía) en el entorno. */
export function isAdminConfigured(): boolean {
  const p = process.env['ADMIN_PASSWORD'];
  return typeof p === 'string' && p.length > 0;
}

/** Compara la clave enviada contra ADMIN_PASSWORD. false si no está configurada. */
export function checkAdminPassword(submitted: string): boolean {
  const expected = process.env['ADMIN_PASSWORD'];
  if (!expected) return false;
  return submitted === expected;
}

export function setAdminCookie(): void {
  cookies().set(ADMIN_COOKIE, ADMIN_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 8, // 8 horas — el acceso admin caduca antes que el de la app
  });
}

export function clearAdminCookie(): void {
  cookies().delete(ADMIN_COOKIE);
}

/** True si el usuario ya pasó el gate de admin (cookie admin_auth válida). */
export function isAdmin(): boolean {
  return cookies().get(ADMIN_COOKIE)?.value === ADMIN_COOKIE_VALUE;
}
