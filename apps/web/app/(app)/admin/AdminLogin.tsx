'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Formulario de acceso al admin. Se muestra cuando el usuario está logueado a la
 * app pero NO pasó el gate de admin (no tiene la cookie admin_auth). Pide la
 * ADMIN_PASSWORD; si es correcta, el endpoint setea la cookie y recargamos.
 */
export function AdminLogin({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !data.ok) {
        setError(data.error ?? 'No se pudo entrar');
        setBusy(false);
        return;
      }
      // Cookie de admin seteada → recargar para que la página muestre el panel.
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <Card className="max-w-md">
        <CardContent className="space-y-2 pt-6 text-sm">
          <p className="font-semibold">⚠️ Admin sin configurar</p>
          <p className="text-muted-foreground">
            No hay una <code className="font-mono">ADMIN_PASSWORD</code> definida en el{' '}
            <code className="font-mono">.env</code>. Agrégala (y reinicia el servidor) para poder
            entrar al panel de administración.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-md">
      <CardContent className="pt-6">
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-pw">Clave de administrador</Label>
            <Input
              id="admin-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Ingresa la clave de admin"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Es una clave aparte de la de la app — solo los administradores la tienen.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Entrando…' : 'Entrar al admin'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
