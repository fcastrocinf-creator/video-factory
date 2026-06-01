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

/**
 * True si esta instalación es la del OWNER (propietario). Se controla con la
 * variable de entorno VF_ROLE=owner en el .env. En el modelo local-first, las
 * instalaciones de empleados NO la setean (default = usuario) → no ven /admin.
 *
 * NOTA: oculta el admin a usuarios de confianza; NO es seguridad blindada
 * (ellos tienen el código y podrían cambiar su propio flag). La seguridad dura
 * requeriría el modelo de servidor central con cuentas reales.
 */
export function isOwner(): boolean {
  return process.env['VF_ROLE'] === 'owner';
}
