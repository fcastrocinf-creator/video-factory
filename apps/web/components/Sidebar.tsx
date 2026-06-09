'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const GROUPS: Array<{
  label: string;
  items: Array<{ href: string; icon: string; name: string; sub?: string; ownerOnly?: boolean }>;
}> = [
  {
    label: 'Principal',
    items: [{ href: '/runs', icon: '📁', name: 'Mis videos', sub: 'ver y editar' }],
  },
  {
    label: 'Marca',
    items: [
      { href: '/brands', icon: '🏷️', name: 'Marcas', sub: 'productos y estilo' },
      { href: '/ctas', icon: '📣', name: 'CTAs', sub: 'cierres por marca' },
    ],
  },
  {
    label: 'Inteligencia',
    items: [
      { href: '/sugerencias', icon: '🧠', name: 'Asistente IA', sub: 'ideas · estilo · técnico' },
      { href: '/laboratorio', icon: '🧪', name: 'Laboratorio de Prompts', sub: 'genera · juzga · refina' },
      { href: '/aprendizaje', icon: '🎓', name: 'Aprendizaje', sub: 'enseñar estilos' },
    ],
  },
  {
    label: 'Sistema',
    items: [{ href: '/admin', icon: '⚙️', name: 'Admin', ownerOnly: true }],
  },
];

export function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const path = usePathname() ?? '';
  const [createOpen, setCreateOpen] = useState(false);
  // Oculta los items marcados ownerOnly (ej. Admin) salvo que seas el owner.
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.ownerOnly || isAdmin),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 border-r border-border bg-card/40 p-3.5 backdrop-blur-xl">
        <Link
          href="/runs"
          className="flex items-center gap-2.5 px-2 pb-3.5 pt-1.5 text-base font-bold tracking-tight"
        >
          <span
            className="grid h-7 w-7 place-items-center rounded-[9px] text-base shadow-[0_4px_14px_-4px_hsl(247_100%_71%/0.7)] ring-1 ring-white/10"
            style={{ background: 'linear-gradient(135deg,#8b7bff,#5b4bd6)' }}
          >
            🎬
          </span>
          Video Factory
        </Link>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
          style={{
            background: 'linear-gradient(135deg,#7c6cff,#9d8bff)',
            boxShadow: '0 8px 22px -8px #7c6cff',
          }}
        >
          ＋ Crear video
        </button>

        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2.5 pb-1.5 pt-3.5 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
              {g.label}
            </div>
            {g.items.map((it) => {
              const active = path === it.href || path.startsWith(it.href + '/');
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={
                    'group relative flex items-center gap-3 rounded-[10px] px-2.5 py-2.5 font-medium transition-colors ' +
                    (active
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')
                  }
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(247_100%_71%/0.85)]" />
                  )}
                  <span className="w-5 text-center text-base">{it.icon}</span>
                  <span className="leading-tight">
                    {it.name}
                    {it.sub && (
                      <span className="mt-px block text-xs font-normal text-muted-foreground/70">
                        {it.sub}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}

        <div className="mt-auto flex items-center gap-2 border-t border-border px-2.5 pt-2.5 text-xs text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          Todo operativo
        </div>
      </aside>

      {createOpen && <CreateChooser onClose={() => setCreateOpen(false)} />}
    </>
  );
}

// Selector "Desde cero / Ripear" — coincide con el prototipo aprobado.
function CreateChooser({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-elevation animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-foreground">Crear video</h2>
            <p className="text-sm text-muted-foreground">¿Cómo quieres empezar?</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          <Link
            href="/create"
            onClick={onClose}
            className="flex items-start gap-3 rounded-xl border border-border p-3.5 transition-colors hover:border-primary/60 hover:bg-primary/10"
          >
            <span className="text-2xl leading-none">✨</span>
            <span>
              <span className="block font-semibold text-foreground">Desde cero</span>
              <span className="block text-xs text-muted-foreground">
                Escribe el guión y elige el estilo. Ideal para una idea nueva.
              </span>
            </span>
          </Link>

          <Link
            href="/rip"
            onClick={onClose}
            className="flex items-start gap-3 rounded-xl border border-border p-3.5 transition-colors hover:border-primary/60 hover:bg-primary/10"
          >
            <span className="text-2xl leading-none">🎯</span>
            <span>
              <span className="flex items-center gap-2 font-semibold text-foreground">
                Ripear un anuncio
                <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-primary">
                  recomendado
                </span>
              </span>
              <span className="block text-xs text-muted-foreground">
                Sube un video que funciona y replícalo — cambia estilo, idioma o producto.
              </span>
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
