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
    items: [{ href: '/brands', icon: '🏷️', name: 'Marcas', sub: 'productos y estilo' }],
  },
  {
    label: 'Inteligencia',
    items: [
      { href: '/sugerencias', icon: '🧠', name: 'Asistente IA', sub: 'ideas · estilo · técnico' },
      { href: '/aprendizaje', icon: '🎓', name: 'Aprendizaje', sub: 'enseñar estilos' },
    ],
  },
  {
    label: 'Sistema',
    items: [{ href: '/admin', icon: '⚙️', name: 'Admin', ownerOnly: true }],
  },
];

export function Sidebar({ isOwner = false }: { isOwner?: boolean }) {
  const path = usePathname() ?? '';
  const [createOpen, setCreateOpen] = useState(false);
  // Oculta los items marcados ownerOnly (ej. Admin) salvo que seas el owner.
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.ownerOnly || isOwner),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <aside className="w-60 shrink-0 bg-[#15171e] border-r border-[#2a2f3c] p-3.5 flex flex-col gap-1 sticky top-0 h-screen">
        <Link href="/runs" className="flex items-center gap-2.5 font-bold text-base px-2 pt-1.5 pb-3.5">
          <span
            className="w-7 h-7 rounded-[9px] grid place-items-center text-base"
            style={{ background: 'linear-gradient(135deg,#7c6cff,#ffcf4a)' }}
          >
            🎬
          </span>
          Video Factory
        </Link>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-semibold text-sm mb-2 w-full"
          style={{ background: 'linear-gradient(135deg,#7c6cff,#9d8bff)', boxShadow: '0 6px 18px -6px #7c6cff' }}
        >
          ＋ Crear video
        </button>

        {groups.map((g) => (
          <div key={g.label}>
            <div className="text-[10.5px] tracking-[0.09em] uppercase text-[#6b7385] px-2.5 pt-3.5 pb-1.5 font-bold">
              {g.label}
            </div>
            {g.items.map((it) => {
              const active = path === it.href || path.startsWith(it.href + '/');
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={
                    'flex items-center gap-3 px-2.5 py-2.5 rounded-[10px] font-medium transition-colors ' +
                    (active
                      ? 'bg-[#262a3a] text-white'
                      : 'text-[#9aa3b2] hover:bg-[#222633] hover:text-white')
                  }
                >
                  <span className="text-base w-5 text-center">{it.icon}</span>
                  <span className="leading-tight">
                    {it.name}
                    {it.sub && <span className="block text-[11px] text-[#6b7385] font-normal mt-px">{it.sub}</span>}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}

        <div className="mt-auto pt-2.5 border-t border-[#2a2f3c] text-[11px] text-[#6b7385] flex items-center gap-2 px-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Todo operativo
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
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[#2a2f3c] bg-[#15171e] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Crear video</h2>
            <p className="text-sm text-[#9aa3b2]">¿Cómo quieres empezar?</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#6b7385] hover:text-white text-xl leading-none"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          <Link
            href="/create"
            onClick={onClose}
            className="flex items-start gap-3 rounded-xl border border-[#2a2f3c] p-3.5 hover:border-[#7c6cff] hover:bg-[#7c6cff]/10 transition-colors"
          >
            <span className="text-2xl leading-none">✨</span>
            <span>
              <span className="block font-semibold text-white">Desde cero</span>
              <span className="block text-xs text-[#9aa3b2]">
                Escribe el guión y elige el estilo. Ideal para una idea nueva.
              </span>
            </span>
          </Link>

          <Link
            href="/rip"
            onClick={onClose}
            className="flex items-start gap-3 rounded-xl border border-[#2a2f3c] p-3.5 hover:border-[#7c6cff] hover:bg-[#7c6cff]/10 transition-colors"
          >
            <span className="text-2xl leading-none">🎯</span>
            <span>
              <span className="flex items-center gap-2 font-semibold text-white">
                Ripear un anuncio
                <span className="rounded-full bg-[#7c6cff]/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#b3a9ff]">
                  recomendado
                </span>
              </span>
              <span className="block text-xs text-[#9aa3b2]">
                Sube un video que funciona y replícalo — cambia estilo, idioma o producto.
              </span>
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
