'use client';

import { useRef, useState } from 'react';

type CtaItem = {
  id: string;
  file: string;
  type: 'image' | 'video';
  contentType: string;
  label: string;
  createdAt: string;
};
type BrandCtas = { id: string; displayName: string; ctas: CtaItem[] };

export function CtasManager({ brands }: { brands: BrandCtas[] }) {
  const [data, setData] = useState<BrandCtas[]>(brands);
  const [selectedId, setSelectedId] = useState<string>(brands[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = data.find((b) => b.id === selectedId) ?? null;

  if (brands.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/40 p-8 text-center text-muted-foreground">
        No hay marcas todavía. Crea una marca en <b className="text-foreground">Marcas</b> para
        guardarle CTAs.
      </div>
    );
  }

  function fileUrl(ctaId: string): string {
    return `/api/brands/${selectedId}/ctas/${ctaId}/file`;
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Elige una imagen o video');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', label);
      const res = await fetch(`/api/brands/${selectedId}/ctas`, { method: 'POST', body: fd });
      const json = (await res.json()) as { cta?: CtaItem; error?: string };
      if (!res.ok || !json.cta) {
        setError(json.error ?? 'Error al subir');
        return;
      }
      const cta = json.cta;
      setData((prev) =>
        prev.map((b) => (b.id === selectedId ? { ...b, ctas: [cta, ...b.ctas] } : b)),
      );
      setLabel('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(ctaId: string) {
    if (!window.confirm('¿Borrar este CTA?')) return;
    const res = await fetch(`/api/brands/${selectedId}/ctas/${ctaId}`, { method: 'DELETE' });
    if (res.ok) {
      setData((prev) =>
        prev.map((b) =>
          b.id === selectedId ? { ...b, ctas: b.ctas.filter((c) => c.id !== ctaId) } : b,
        ),
      );
    }
  }

  return (
    <div className="space-y-5">
      {/* Selector de marca */}
      <div className="flex flex-wrap gap-2">
        {data.map((b) => {
          const active = b.id === selectedId;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelectedId(b.id)}
              className={
                'rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ' +
                (active
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground')
              }
            >
              {b.displayName}
              <span className="ml-2 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                {b.ctas.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* Subir un CTA */}
      <form
        onSubmit={handleUpload}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1 space-y-1.5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Archivo (imagen o video, máx 60 MB)
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime"
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/15 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-primary/25"
          />
        </div>
        <div className="flex-1 space-y-1.5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Nombre (opcional)
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ej: Canela apunta abajo"
            className="block w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={uploading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
        >
          {uploading ? 'Subiendo…' : '＋ Guardar CTA'}
        </button>
      </form>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Grilla de CTAs */}
      {selected && selected.ctas.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/20 p-8 text-center text-muted-foreground">
          Esta marca todavía no tiene CTAs. Sube el primero arriba ↑
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {selected?.ctas.map((cta) => (
            <div
              key={cta.id}
              className="group overflow-hidden rounded-xl border border-border bg-card/40"
            >
              <div className="relative aspect-[9/16] bg-black/40">
                {cta.type === 'video' ? (
                  <video
                    src={fileUrl(cta.id)}
                    className="h-full w-full object-cover"
                    muted
                    loop
                    playsInline
                    controls
                    preload="metadata"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={fileUrl(cta.id)}
                    alt={cta.label}
                    className="h-full w-full object-cover"
                  />
                )}
                <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  {cta.type === 'video' ? '🎬 video' : '🖼️ imagen'}
                </span>
              </div>
              <div className="space-y-2 p-2.5">
                <p className="truncate text-sm font-medium text-foreground" title={cta.label}>
                  {cta.label}
                </p>
                <div className="flex items-center gap-2">
                  <a
                    href={`${fileUrl(cta.id)}?download=1`}
                    className="flex-1 rounded-md border border-border px-2 py-1 text-center text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    Descargar
                  </a>
                  <button
                    type="button"
                    onClick={() => handleDelete(cta.id)}
                    className="rounded-md border border-border px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10"
                    aria-label="Borrar CTA"
                  >
                    Borrar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
