'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';

interface PendingItem {
  id: string;
  displayName: string;
  description: string;
  categoryDisplayName: string | null;
  formatDisplayName: string | null;
  estrategia: 'plano_fijo' | 'multi_escena';
  visualEngine: string;
  defaultDurationSeconds: number;
  scenesPerMinute: number;
  hasPreview: boolean;
  createdAt: string;
}

interface AdminPanelProps {
  initialPending: PendingItem[];
}

const FORMAT_OPTIONS: Array<{ id: string; displayName: string }> = [
  { id: 'b-roll-static', displayName: 'B-ROLL Estático' },
  { id: 'b-roll-animated', displayName: 'B-ROLL Animado' },
  { id: 'ugc-broll', displayName: 'UGC B-ROLL' },
  { id: 'ugc-testimony', displayName: 'UGC Testimonio' },
  { id: 'vsl', displayName: 'VSL (Sales Letter)' },
  { id: 'voiceover-animated', displayName: 'Voice Over Animado' },
];

const ENGINE_OPTIONS = [
  'imagen4',
  'veo-lite',
  'veo-fast',
  'veo-standard',
  'higgsfield',
] as const;

export function AdminPanel({ initialPending }: AdminPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingItem[]>(initialPending);
  const [globalError, setGlobalError] = useState('');
  const [isRefreshing, startRefresh] = useTransition();

  async function refresh() {
    startRefresh(() => {
      router.refresh();
    });
    try {
      const r = await fetch('/api/admin/presets/pending', { cache: 'no-store' });
      if (r.ok) {
        const data = (await r.json()) as { pending: PendingItem[] };
        setPending(data.pending);
      }
    } catch {
      // ignored
    }
  }

  function removeLocal(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  function updateLocal(id: string, patch: Partial<PendingItem>) {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  if (pending.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6 text-center space-y-3">
            <div className="text-5xl">🧠</div>
            <p className="text-sm font-medium">Sin presets pendientes de aprobación</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              Cuando alguien suba un video en <a href="/rip" className="underline">/rip</a>{' '}
              y dispare un ripeo, el sistema construirá un preset aprendido (estilo,
              categoría, formato, paleta) y aparecerá aquí para tu revisión.
            </p>
            <Button onClick={refresh} variant="outline" size="sm" disabled={isRefreshing}>
              {isRefreshing ? 'Refrescando…' : 'Refrescar'}
            </Button>
          </CardContent>
        </Card>

        {/* Base de Conocimiento (Fase 1) — visible aunque no haya presets pendientes */}
        <KnowledgeBaseSection />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          <strong>{pending.length}</strong> preset{pending.length === 1 ? '' : 's'} pendiente
          {pending.length === 1 ? '' : 's'} de revisión
        </p>
        <Button onClick={refresh} variant="outline" size="sm" disabled={isRefreshing}>
          {isRefreshing ? 'Refrescando…' : 'Refrescar'}
        </Button>
      </div>

      {globalError && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{globalError}</p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {pending.map((item) => (
          <PendingCard
            key={item.id}
            item={item}
            onApproved={() => removeLocal(item.id)}
            onRejected={() => removeLocal(item.id)}
            onUpdated={(patch) => updateLocal(item.id, patch)}
            onError={setGlobalError}
          />
        ))}
      </div>

      {/* M7 #5 — Cerebro evolutivo: propuestas de patches automáticos a prompts */}
      <PromptPatchesSection />

      {/* Base de Conocimiento (Fase 1): vista de todo lo que el sistema registra */}
      <KnowledgeBaseSection />
    </div>
  );
}

function PendingCard({
  item,
  onApproved,
  onRejected,
  onUpdated,
  onError,
}: {
  item: PendingItem;
  onApproved: () => void;
  onRejected: () => void;
  onUpdated: (patch: Partial<PendingItem>) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'approving' | 'rejecting' | 'saving'>('idle');
  const [draft, setDraft] = useState({
    displayName: item.displayName,
    description: item.description,
    formatId: detectFormatId(item.formatDisplayName),
    formatDisplay: item.formatDisplayName ?? '',
    visualEngine: item.visualEngine,
    estrategia: item.estrategia,
    defaultDurationSeconds: item.defaultDurationSeconds,
    scenesPerMinute: item.scenesPerMinute,
  });
  // Preview con cache-buster por si el GIF cambia entre renders del mismo id
  const [previewCacheBust, setPreviewCacheBust] = useState(0);

  async function approve() {
    if (!confirm(`¿Aprobar "${item.displayName}"? Va a aparecer en /create.`)) return;
    setBusy('approving');
    try {
      const r = await fetch(`/api/admin/presets/${item.id}/approve`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      onApproved();
    } catch (e) {
      onError((e as Error).message);
      setBusy('idle');
    }
  }

  async function reject() {
    if (!confirm(`¿Rechazar y borrar "${item.displayName}"? No se puede deshacer.`)) return;
    setBusy('rejecting');
    try {
      const r = await fetch(`/api/admin/presets/${item.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      onRejected();
    } catch (e) {
      onError((e as Error).message);
      setBusy('idle');
    }
  }

  async function saveEdits() {
    setBusy('saving');
    try {
      const matchingFormat = FORMAT_OPTIONS.find((f) => f.id === draft.formatId);
      const body = {
        displayName: draft.displayName,
        description: draft.description,
        visualEngine: draft.visualEngine,
        estrategia: draft.estrategia,
        defaultDurationSeconds: draft.defaultDurationSeconds,
        scenesPerMinute: draft.scenesPerMinute,
        ...(matchingFormat
          ? {
              format: {
                id: matchingFormat.id,
                displayName: matchingFormat.displayName,
              },
            }
          : {}),
      };
      const r = await fetch(`/api/admin/presets/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      onUpdated({
        displayName: draft.displayName,
        description: draft.description,
        visualEngine: draft.visualEngine,
        estrategia: draft.estrategia,
        defaultDurationSeconds: draft.defaultDurationSeconds,
        scenesPerMinute: draft.scenesPerMinute,
        formatDisplayName: matchingFormat?.displayName ?? item.formatDisplayName,
      });
      setEditing(false);
      setBusy('idle');
      setPreviewCacheBust((n) => n + 1);
    } catch (e) {
      onError((e as Error).message);
      setBusy('idle');
    }
  }

  const isPlanoFijo = draft.estrategia === 'plano_fijo';

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-3 pt-5">
        <div className="grid grid-cols-[1fr_140px] gap-4 items-start">
          <div className="space-y-1 min-w-0">
            <h3 className="text-base font-semibold leading-tight truncate" title={item.displayName}>
              {item.displayName}
            </h3>
            <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
            <div className="flex flex-wrap gap-1 pt-1">
              {item.categoryDisplayName && (
                <Tag>{item.categoryDisplayName}</Tag>
              )}
              {item.formatDisplayName && <Tag>{item.formatDisplayName}</Tag>}
              <Tag>{item.estrategia}</Tag>
              <Tag>{item.visualEngine}</Tag>
              <Tag>{item.defaultDurationSeconds}s</Tag>
            </div>
          </div>
          {/* GIF preview */}
          <div className="space-y-1">
            {item.hasPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/presets/${item.id}/preview?v=${previewCacheBust}`}
                alt={`preview ${item.displayName}`}
                className="w-full aspect-[9/16] rounded-md border bg-muted object-cover"
              />
            ) : (
              <div className="aspect-[9/16] w-full rounded-md border border-dashed bg-muted/40 flex flex-col items-center justify-center text-center text-[10px] text-muted-foreground p-2">
                <span className="text-xl">🎬</span>
                <span className="mt-1">Sin preview todavía. Se genera al primer render con este estilo.</span>
              </div>
            )}
          </div>
        </div>

        {editing && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Nombre</Label>
                <Input
                  value={draft.displayName}
                  onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
                  disabled={busy !== 'idle'}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Formato</Label>
                <Select
                  value={draft.formatId ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, formatId: e.target.value }))}
                  disabled={busy !== 'idle'}
                >
                  <option value="">— sin formato —</option>
                  {FORMAT_OPTIONS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.displayName}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Visual engine</Label>
                <Select
                  value={draft.visualEngine}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, visualEngine: e.target.value }))
                  }
                  disabled={busy !== 'idle'}
                >
                  {ENGINE_OPTIONS.map((eng) => (
                    <option key={eng} value={eng}>
                      {eng}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Estrategia</Label>
                <Select
                  value={draft.estrategia}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      estrategia: e.target.value as 'plano_fijo' | 'multi_escena',
                    }))
                  }
                  disabled={busy !== 'idle'}
                >
                  <option value="multi_escena">multi_escena (recomendado)</option>
                  <option value="plano_fijo">plano_fijo (legacy)</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Duración (s)</Label>
                <Input
                  type="number"
                  min={5}
                  max={600}
                  value={draft.defaultDurationSeconds}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      defaultDurationSeconds: Math.max(5, Number(e.target.value) || 5),
                    }))
                  }
                  disabled={busy !== 'idle'}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Escenas / minuto</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={draft.scenesPerMinute}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      scenesPerMinute: Math.max(1, Number(e.target.value) || 1),
                    }))
                  }
                  disabled={busy !== 'idle' || isPlanoFijo}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Descripción</Label>
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                disabled={busy !== 'idle'}
                rows={2}
                className="text-xs"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy !== 'idle'}>
                Cancelar
              </Button>
              <Button size="sm" onClick={saveEdits} disabled={busy !== 'idle'}>
                {busy === 'saving' ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-1">
          {!editing && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy !== 'idle'}>
              Editar
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={reject} disabled={busy !== 'idle'}>
            {busy === 'rejecting' ? 'Rechazando…' : 'Rechazar'}
          </Button>
          <Button size="sm" onClick={approve} disabled={busy !== 'idle'}>
            {busy === 'approving' ? 'Aprobando…' : '✓ Aprobar'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function detectFormatId(displayName: string | null): string | undefined {
  if (!displayName) return undefined;
  const match = FORMAT_OPTIONS.find((f) =>
    displayName.toLowerCase().includes(f.displayName.toLowerCase()),
  );
  return match?.id;
}

// ============================================================
// M7 #5 — Cerebro evolutivo: panel de prompt patches propuestos
// ============================================================
// Lista patches que el detector de patrones identificó como sistémicos.
// Owner puede aprobar (aplica al archivo source) o rechazar.

interface PatchProposal {
  id: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  pattern: {
    patternId: string;
    category: string;
    affectedBlock: string;
    occurrenceCount: number;
    affectedRunIds: string[];
    description: string;
    severityScore: number;
  };
  targetFilePath: string;
  patchType: 'addition' | 'modification' | 'reinforcement' | 'removal';
  oldText: string | null;
  newText: string;
  reasoning: string;
  expectedImprovement: string;
  confidence: number;
  proposedByModel: string;
}

// ─── Base de Conocimiento (Fase 1): vista de lo que el sistema registra ───────

interface KbEventoView {
  id: string;
  ts: string;
  codeVersion?: string;
  vault: string;
  subsistema: string;
  tipo: string;
  severidad?: string;
  estado?: string;
  titulo: string;
  fuente: string;
  entidad?: {
    brandId?: string;
    presetId?: string;
    runId?: string;
    sceneIndex?: number;
    userId?: string;
  };
  tags?: string[];
}

interface KbStatsView {
  total: number;
  porVault: Record<string, number>;
  porSubsistema: Record<string, number>;
  porTipo: Record<string, number>;
  ultimoTs: string | null;
  codeVersion: string | null;
}

function fmtTs(ts: string): string {
  return ts.length >= 16 ? ts.slice(0, 16).replace('T', ' ') : ts;
}

function entidadResumen(en?: KbEventoView['entidad']): string {
  if (!en) return '';
  const parts: string[] = [];
  if (en.runId) parts.push(`run:${en.runId.slice(0, 8)}`);
  if (en.presetId) parts.push(`preset:${en.presetId}`);
  if (en.brandId) parts.push(`brand:${en.brandId}`);
  if (typeof en.sceneIndex === 'number') parts.push(`escena:${en.sceneIndex}`);
  return parts.join(' · ');
}

function severityClass(sev?: string): string {
  if (sev === 'critical') return 'bg-red-500/20 text-red-700 dark:text-red-300';
  if (sev === 'high') return 'bg-orange-500/20 text-orange-700 dark:text-orange-300';
  if (sev === 'medium') return 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300';
  return 'bg-muted text-muted-foreground';
}

function KnowledgeBaseSection() {
  const [stats, setStats] = useState<KbStatsView | null>(null);
  const [eventos, setEventos] = useState<KbEventoView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tipoFilter, setTipoFilter] = useState<string>('');

  async function load(tipo: string = tipoFilter) {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (tipo) qs.set('tipo', tipo);
      const r = await fetch(`/api/admin/kb?${qs.toString()}`, { cache: 'no-store' });
      const data = (await r.json()) as {
        stats?: KbStatsView;
        eventos?: KbEventoView[];
        error?: string;
      };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setStats(data.stats ?? null);
      setEventos(data.eventos ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Cargar al montar (una sola vez). Mismo patrón que PromptPatchesSection.
  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyTipo(tipo: string) {
    const next = tipo === tipoFilter ? '' : tipo;
    setTipoFilter(next);
    void load(next);
  }

  const tiposOrdenados = stats
    ? Object.entries(stats.porTipo).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <Card className="border-emerald-500/30 bg-emerald-500/5">
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">🧠 Base de Conocimiento</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Aquí queda <strong>registrado y ubicable</strong> todo lo que pasa en la herramienta:
              chats, runs, juicios de presets, sugerencias y tu feedback. La recolección es
              automática y <strong>nada se aplica solo</strong>. Es la base para que los auditores
              profundos (próxima fase) revisen con contexto real.
            </p>
          </div>
          <Button
            onClick={() => void load()}
            disabled={loading}
            size="sm"
            variant="outline"
            className="shrink-0"
          >
            {loading ? 'Cargando…' : 'Actualizar'}
          </Button>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        {stats && (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                Total: <strong>{stats.total}</strong> eventos
              </span>
              {stats.ultimoTs && <span className="text-muted-foreground">último: {fmtTs(stats.ultimoTs)}</span>}
              {stats.codeVersion && (
                <span className="text-muted-foreground">
                  versión: <code className="rounded bg-muted px-1 text-[10px]">{stats.codeVersion}</code>
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(stats.porVault).map(([k, v]) => (
                <span key={k} className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px]">
                  vault {k}: <strong>{v}</strong>
                </span>
              ))}
              {Object.entries(stats.porSubsistema)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span key={k} className="rounded bg-muted px-2 py-0.5 text-[10px]">
                    {k}: {v}
                  </span>
                ))}
            </div>
          </div>
        )}

        {tiposOrdenados.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">Filtrar por tipo:</span>
            {tiposOrdenados.map(([tipo, count]) => (
              <button
                key={tipo}
                onClick={() => applyTipo(tipo)}
                className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                  tipoFilter === tipo
                    ? 'bg-emerald-600 text-white'
                    : 'bg-background/60 text-muted-foreground hover:bg-muted'
                }`}
              >
                {tipo} ({count})
              </button>
            ))}
            {tipoFilter && (
              <button
                onClick={() => applyTipo(tipoFilter)}
                className="rounded px-2 py-0.5 text-[10px] text-muted-foreground underline hover:text-foreground"
              >
                limpiar
              </button>
            )}
          </div>
        )}

        {eventos.length === 0 ? (
          <p className="rounded-md border border-dashed bg-background/30 p-4 text-center text-xs text-muted-foreground">
            {loading
              ? 'Cargando eventos…'
              : tipoFilter
                ? `Sin eventos del tipo "${tipoFilter}".`
                : 'Sin eventos todavía. A medida que uses la herramienta (chats, videos, sugerencias, feedback) se irán registrando aquí.'}
          </p>
        ) : (
          <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
            {eventos.map((ev) => {
              const ent = entidadResumen(ev.entidad);
              return (
                <div
                  key={ev.id}
                  className="rounded-md border border-emerald-500/15 bg-background/60 p-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-muted-foreground text-[10px]">{fmtTs(ev.ts)}</span>
                    <code className="rounded bg-muted px-1 text-[10px]">
                      {ev.subsistema}/{ev.tipo}
                    </code>
                    {ev.severidad && ev.severidad !== 'info' && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${severityClass(ev.severidad)}`}>
                        {ev.severidad}
                      </span>
                    )}
                    {ev.estado && (
                      <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-700 dark:text-blue-300">
                        {ev.estado}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">{ev.fuente}</span>
                  </div>
                  <p className="mt-1">{ev.titulo}</p>
                  {ent && <p className="mt-0.5 text-[10px] text-muted-foreground">{ent}</p>}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PromptPatchesSection() {
  const [patches, setPatches] = useState<PatchProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState('');
  const [detectResult, setDetectResult] = useState<string | null>(null);

  async function loadPatches() {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/prompt-patches', { cache: 'no-store' });
      const data = (await r.json()) as { proposals?: PatchProposal[]; error?: string };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setPatches(data.proposals ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runDetector() {
    setDetecting(true);
    setError('');
    setDetectResult(null);
    try {
      const r = await fetch('/api/admin/prompt-patches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minOccurrences: 3, maxAgeDays: 30, maxRuns: 50 }),
      });
      const data = (await r.json()) as {
        patternsDetected?: number;
        proposalsCreated?: number;
        message?: string;
        errors?: string[];
        error?: string;
      };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setDetectResult(
        `Patrones detectados: ${data.patternsDetected ?? 0} · Patches propuestos: ${data.proposalsCreated ?? 0}. ${data.message ?? ''}${(data.errors ?? []).length > 0 ? '\nErrores: ' + (data.errors ?? []).join('; ') : ''}`,
      );
      await loadPatches();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  async function decidePatch(patchId: string, action: 'approve' | 'reject') {
    try {
      const r = await fetch(`/api/admin/prompt-patches/${patchId}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string; reminder?: string };
      if (!r.ok || !data.ok) {
        setError(data.error ?? `HTTP ${r.status}`);
        return;
      }
      if (data.reminder) setDetectResult(data.reminder);
      await loadPatches();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Cargar al montar (UNA sola vez). Anti-pattern previo: llamar loadPatches()
  // dentro del render podía causar loops infinitos si setState no se aplicaba
  // sincrónicamente. useEffect garantiza una sola llamada post-mount.
  useEffect(() => {
    void loadPatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="border-purple-500/30 bg-purple-500/5">
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">🧬 Cerebro evolutivo — Prompt patches</p>
            <p className="mt-1 text-xs text-muted-foreground">
              El sistema escanea logs + post-render-reports buscando errores que se REPITEN en
              varios runs. Por cada patrón detectado, Claude Sonnet propone un patch al SYSTEM_PROMPT
              del bloque afectado. Vos aprobás o rechazás. Si aprobás, el patch se aplica al archivo
              source (NO commit automático). Reiniciá dev server para que tome efecto.
            </p>
          </div>
          <Button
            onClick={runDetector}
            disabled={detecting}
            size="sm"
            className="shrink-0 bg-purple-600 hover:bg-purple-700"
          >
            {detecting ? 'Escaneando…' : '🔍 Escanear patrones'}
          </Button>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}
        {detectResult && (
          <p className="rounded-md bg-blue-500/10 px-3 py-2 text-xs whitespace-pre-line">
            {detectResult}
          </p>
        )}

        {patches.length === 0 ? (
          <p className="rounded-md border border-dashed bg-background/30 p-4 text-center text-xs text-muted-foreground">
            Sin patches propuestos. Apretá "Escanear patrones" para que el sistema busque errores
            sistémicos en runs recientes y proponga mejoras al código.
          </p>
        ) : (
          <div className="space-y-3">
            {patches.map((p) => (
              <div
                key={p.id}
                className="rounded-md border border-purple-500/20 bg-background/60 p-3 text-xs space-y-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="rounded bg-purple-500/20 px-2 py-0.5 font-semibold uppercase tracking-wide text-[10px] text-purple-700 dark:text-purple-300">
                    {p.pattern.category}
                  </span>
                  <span className="text-muted-foreground">→</span>
                  <code className="rounded bg-muted px-1 text-[10px]">{p.pattern.affectedBlock}</code>
                  <span className="text-muted-foreground">
                    {p.pattern.occurrenceCount} runs · severity {p.pattern.severityScore.toFixed(1)}
                  </span>
                  <span className="ml-auto">
                    confidence <strong>{p.confidence}/100</strong>
                  </span>
                </div>

                <p className="italic text-muted-foreground">{p.pattern.description}</p>

                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Ver patch propuesto ({p.patchType}) →
                    <code className="ml-1 text-[10px]">
                      {p.targetFilePath.split(/[\\/]/).slice(-3).join('/')}
                    </code>
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <p className="font-semibold text-muted-foreground">Razonamiento:</p>
                      <p>{p.reasoning}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-muted-foreground">Mejora esperada:</p>
                      <p>{p.expectedImprovement}</p>
                    </div>
                    {p.oldText && (
                      <div>
                        <p className="font-semibold text-red-600 dark:text-red-400">
                          − Reemplazar:
                        </p>
                        <pre className="overflow-x-auto rounded bg-red-500/10 p-2 text-[10px] whitespace-pre-wrap">
                          {p.oldText}
                        </pre>
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-green-600 dark:text-green-400">
                        + Con:
                      </p>
                      <pre className="overflow-x-auto rounded bg-green-500/10 p-2 text-[10px] whitespace-pre-wrap">
                        {p.newText}
                      </pre>
                    </div>
                  </div>
                </details>

                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={() => decidePatch(p.id, 'approve')}
                    size="sm"
                    className="bg-green-600 hover:bg-green-700"
                  >
                    ✓ Aprobar y aplicar
                  </Button>
                  <Button
                    onClick={() => decidePatch(p.id, 'reject')}
                    size="sm"
                    variant="outline"
                  >
                    ✗ Rechazar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
