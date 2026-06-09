'use client';

import { useEffect, useRef, useState } from 'react';

type Brand = { id: string; displayName: string };
type LibItem = {
  id: string;
  mode: string;
  intention: string;
  score: number;
  prompt: string;
  brandId: string | null;
};
type Iteration = {
  iteration: number;
  prompt: string;
  score: number;
  approved: boolean;
  notVerified: boolean;
  hint: string;
  failedCriteria: string[];
  imagePath?: string;
};
type Trajectory = {
  id: string;
  status: 'running' | 'done' | 'error';
  mode: string;
  intention: string;
  threshold: number;
  rubric: { id: string; description: string; weight: number; critical: boolean }[];
  basePrompt: string;
  seedUsedId?: string | null;
  iterations: Iteration[];
  result?: {
    approved: boolean;
    notVerified: boolean;
    bestPrompt: string;
    bestScore: number;
    bestImageFile?: string;
    stopReason: string;
  };
  savedToLibraryId?: string | null;
  error?: string;
};

export function PromptLab({ brands, initialLibrary }: { brands: Brand[]; initialLibrary: LibItem[] }) {
  const [intention, setIntention] = useState('');
  const [brandId, setBrandId] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(4);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traj, setTraj] = useState<Trajectory | null>(null);
  const [library, setLibrary] = useState<LibItem[]>(initialLibrary);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function refreshLibrary() {
    try {
      const res = await fetch('/api/promptlab/library');
      if (res.ok) {
        const json = (await res.json()) as { prompts: Array<LibItem & { ts: string }> };
        setLibrary(
          json.prompts.map((p) => ({
            id: p.id,
            mode: p.mode,
            intention: p.intention ?? '',
            score: p.score,
            prompt: p.prompt,
            brandId: p.brandId ?? null,
          })),
        );
      }
    } catch {
      /* no-op */
    }
  }

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (intention.trim().length < 5) {
      setError('Describe la escena (mínimo 5 caracteres)');
      return;
    }
    setError(null);
    setTraj(null);
    setRunning(true);
    try {
      const res = await fetch('/api/promptlab', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intention: intention.trim(),
          brandId: brandId || undefined,
          maxAttempts,
        }),
      });
      const json = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !json.id) {
        setError(json.error ?? 'Error al iniciar');
        setRunning(false);
        return;
      }
      const id = json.id;
      // Poll cada 2s.
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/promptlab/${id}`);
          if (!r.ok) return;
          const t = (await r.json()) as Trajectory;
          setTraj(t);
          if (t.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current);
            setRunning(false);
            if (t.result?.approved) void refreshLibrary();
          }
        } catch {
          /* sigue intentando */
        }
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
    }
  }

  const result = traj?.result;

  return (
    <div className="space-y-6">
      {/* Formulario */}
      <form onSubmit={handleRun} className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            ¿Qué escena quieres? (en español)
          </label>
          <textarea
            value={intention}
            onChange={(e) => setIntention(e.target.value)}
            rows={3}
            placeholder="Ej: una mujer de 40 sosteniendo el frasco de canela en una cocina luminosa, mood cálido y calmo, estilo foto real, sin texto"
            className="block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Marca (opcional)
            </label>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">— ninguna —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Máx. intentos
            </label>
            <input
              type="number"
              min={1}
              max={8}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Math.max(1, Math.min(8, Number(e.target.value) || 4)))}
              className="w-20 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={running}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {running ? 'Refinando…' : '🧪 Generar y refinar'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Cada intento genera 1 imagen + la juzga la IA. Gasta créditos de generación. Se detiene al aprobar
          o al agotar los intentos.
        </p>
      </form>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Trayectoria en vivo */}
      {traj && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold text-foreground">
              {traj.status === 'running' ? '⏳ Refinando…' : traj.status === 'error' ? '⚠️ Error' : 'Terminado'}
            </span>
            <span className="text-muted-foreground">
              modo {traj.mode} · umbral {traj.threshold} · {traj.iterations.length} intento(s)
            </span>
            {traj.seedUsedId && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                🌱 sembrado desde la librería
              </span>
            )}
          </div>

          {traj.rubric.length > 0 && (
            <details className="rounded-lg border border-border bg-card/30 p-3 text-sm">
              <summary className="cursor-pointer font-medium text-foreground">
                Rúbrica que la IA debe cumplir ({traj.rubric.length})
              </summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {traj.rubric.map((c) => (
                  <li key={c.id}>
                    <b className="text-foreground">[{c.id}]</b> {c.description}{' '}
                    {c.critical && <span className="text-amber-400">· crítico</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {traj.iterations.map((it) => (
              <div
                key={it.iteration}
                className={
                  'overflow-hidden rounded-xl border bg-card/40 ' +
                  (it.approved ? 'border-emerald-500/60' : 'border-border')
                }
              >
                <div className="relative aspect-[9/16] bg-black/40">
                  {it.imagePath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/promptlab/${traj.id}/image?file=${encodeURIComponent(it.imagePath)}`}
                      alt={`Intento ${it.iteration}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-xs text-muted-foreground">
                      sin imagen
                    </div>
                  )}
                  <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
                    intento {it.iteration}
                  </span>
                  <span
                    className={
                      'absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-bold ' +
                      (it.notVerified
                        ? 'bg-amber-500/80 text-white'
                        : it.approved
                          ? 'bg-emerald-500/90 text-white'
                          : 'bg-black/60 text-white')
                    }
                  >
                    {it.notVerified ? 'no verif.' : `${it.score}/100`}
                  </span>
                </div>
                <div className="space-y-1 p-2.5 text-xs">
                  {it.approved ? (
                    <p className="font-semibold text-emerald-400">✓ Aprobada</p>
                  ) : it.hint ? (
                    <p className="text-muted-foreground">
                      <b className="text-foreground">Mejorar:</b> {it.hint}
                    </p>
                  ) : null}
                  {it.failedCriteria.length > 0 && (
                    <p className="text-muted-foreground">Falló: {it.failedCriteria.join(', ')}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Veredicto final */}
          {result && (
            <div
              className={
                'rounded-xl border p-4 ' +
                (result.approved
                  ? 'border-emerald-500/50 bg-emerald-500/5'
                  : result.notVerified
                    ? 'border-amber-500/50 bg-amber-500/5'
                    : 'border-border bg-card/40')
              }
            >
              <p className="text-sm font-semibold text-foreground">
                {result.approved
                  ? `✅ Aprobado (${result.bestScore}/100)`
                  : result.notVerified
                    ? '⚠️ No se pudo verificar (la IA de visión no respondió) — no se aprueba'
                    : `🔁 No alcanzó el umbral (mejor ${result.bestScore}/100) — ${result.stopReason}`}
              </p>
              {traj.savedToLibraryId && (
                <p className="mt-1 text-xs text-emerald-400">🧠 Guardado en la librería de prompts ganadores.</p>
              )}
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer font-medium text-foreground">Mejor prompt</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded-md bg-background p-2 text-muted-foreground">
                  {result.bestPrompt}
                </pre>
              </details>
            </div>
          )}
          {traj.status === 'error' && traj.error && (
            <p className="text-sm text-red-400">Error: {traj.error}</p>
          )}
        </div>
      )}

      {/* Librería de prompts ganadores */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Librería de prompts ganadores ({library.length})
        </h2>
        {library.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay prompts aprendidos. Cuando una visual se apruebe, su prompt se guarda aquí y
            siembra los próximos objetivos parecidos.
          </p>
        ) : (
          <div className="space-y-2">
            {library.map((w) => (
              <details key={w.id} className="rounded-lg border border-border bg-card/30 p-3 text-sm">
                <summary className="cursor-pointer">
                  <span className="font-medium text-foreground">{w.intention || '(sin descripción)'}</span>{' '}
                  <span className="text-muted-foreground">
                    · {w.mode} · {w.score}/100{w.brandId ? ` · ${w.brandId}` : ''}
                  </span>
                </summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-md bg-background p-2 text-xs text-muted-foreground">
                  {w.prompt}
                </pre>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
