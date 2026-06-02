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

// ─── Rediseño UX (dashboard dev calmo, estilo Linear/Vercel) ──────────────────

const TABS = [
  { id: 'estilos', label: 'Estilos', icon: '🎨' },
  { id: 'cerebro', label: 'Cerebro', icon: '🧠' },
  { id: 'costos', label: 'Costos', icon: '📊' },
  { id: 'evolutivo', label: 'Evolutivo', icon: '🧬' },
] as const;
type AdminTab = (typeof TABS)[number]['id'];

// Explicación corta de para qué sirve cada pestaña (para el owner no técnico).
const TAB_HELP: Record<AdminTab, string> = {
  estilos:
    'Estilos que la IA aprendió de tus videos. Apruébalos para que aparezcan al crear, o recházalos.',
  cerebro:
    'La memoria de la herramienta: todo lo que pasa queda registrado, y el Consejo lo audita solo para encontrar mejoras.',
  costos:
    'Cuánto gasta en IA cada empleado/instalación por video — para ver quién es más costo-eficiente.',
  evolutivo:
    'Mejoras a las instrucciones de la IA que el sistema propone cuando detecta errores que se repiten. Tú apruebas.',
};

function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        'group relative overflow-hidden rounded-xl border bg-card/70 px-4 py-3.5 shadow-elevation transition-transform duration-300 hover:-translate-y-0.5 ' +
        (accent ? 'border-primary/40' : 'border-border')
      }
    >
      {/* Línea de luz superior — atmósfera sutil */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-70" />
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-[26px] font-semibold leading-none tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Resumen del estado del admin de un vistazo (regla de los 3 segundos). */
function AdminOverview({ presetsPendientes }: { presetsPendientes: number }) {
  const [kbEventos, setKbEventos] = useState<number | null>(null);
  const [hallazgos, setHallazgos] = useState<number | null>(null);
  const [gastoUsd, setGastoUsd] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const j = (url: string) =>
      fetch(url, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    void (async () => {
      const [kb, audit, central] = await Promise.all([
        j('/api/admin/kb?limit=1'),
        j('/api/admin/kb/audit?limit=200'),
        j('/api/admin/central'),
      ]);
      if (!alive) return;
      setKbEventos(kb?.stats?.total ?? 0);
      setHallazgos(Array.isArray(audit?.hallazgos) ? audit.hallazgos.length : 0);
      const gasto = Array.isArray(central?.stats)
        ? central.stats.reduce(
            (s: number, x: { gastoTotalUsd?: number }) => s + (x.gastoTotalUsd ?? 0),
            0,
          )
        : 0;
      setGastoUsd(gasto);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const cards = [
    { label: 'Estilos pendientes', value: String(presetsPendientes), hint: 'esperan tu aprobación', accent: presetsPendientes > 0 },
    { label: 'Eventos del Cerebro', value: kbEventos === null ? '—' : String(kbEventos), hint: 'actividad registrada', accent: false },
    { label: 'Hallazgos', value: hallazgos === null ? '—' : String(hallazgos), hint: 'detectados por el Consejo', accent: false },
    { label: 'Gasto total', value: gastoUsd === null ? '—' : `$${gastoUsd.toFixed(2)}`, hint: 'estimado en IA', accent: false },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c, i) => (
        <div key={c.label} className="animate-fade-in-up" style={{ animationDelay: `${i * 70}ms` }}>
          <StatCard label={c.label} value={c.value} hint={c.hint} accent={c.accent} />
        </div>
      ))}
    </div>
  );
}

export function AdminPanel({ initialPending }: AdminPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingItem[]>(initialPending);
  const [globalError, setGlobalError] = useState('');
  const [isRefreshing, startRefresh] = useTransition();
  const [tab, setTab] = useState<AdminTab>('estilos');

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

  return (
    <div className="space-y-6">
      {/* Resumen: estado del admin de un vistazo */}
      <AdminOverview presetsPendientes={pending.length} />

      {/* Navegación por pestañas (en vez de la pila vertical) */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                'relative px-4 py-2.5 text-sm font-medium transition-colors ' +
                (active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')
              }
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
              {active && (
                <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary shadow-[0_0_10px_hsl(247_100%_71%_/_0.7)]" />
              )}
            </button>
          );
        })}
      </div>

      {globalError && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{globalError}</p>
      )}

      <div key={tab} className="animate-fade-in-up">
      <p className="mb-3 text-xs text-muted-foreground">{TAB_HELP[tab]}</p>
      {/* ── Pestaña: Estilos pendientes ── */}
      {tab === 'estilos' &&
        (pending.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center space-y-3">
              <div className="text-5xl">🎨</div>
              <p className="text-sm font-medium">Sin estilos pendientes de aprobación</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Cuando alguien suba un video en <a href="/rip" className="underline">/rip</a> y dispare
                un ripeo, el sistema construirá un preset aprendido y aparecerá aquí para tu revisión.
              </p>
              <Button onClick={refresh} variant="outline" size="sm" disabled={isRefreshing}>
                {isRefreshing ? 'Refrescando…' : 'Refrescar'}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                <strong>{pending.length}</strong> estilo{pending.length === 1 ? '' : 's'} pendiente
                {pending.length === 1 ? '' : 's'} de revisión
              </p>
              <Button onClick={refresh} variant="outline" size="sm" disabled={isRefreshing}>
                {isRefreshing ? 'Refrescando…' : 'Refrescar'}
              </Button>
            </div>
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
          </div>
        ))}

      {/* ── Pestaña: Cerebro (Base de Conocimiento + Auditoría) ── */}
      {tab === 'cerebro' && (
        <div className="space-y-4">
          <KnowledgeBaseSection />
          <KnowledgeAuditSection />
        </div>
      )}

      {/* ── Pestaña: Costos ── */}
      {tab === 'costos' && <CentralCostSection />}

      {/* ── Pestaña: Evolutivo (prompt patches) ── */}
      {tab === 'evolutivo' && <PromptPatchesSection />}
      </div>
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
              <div className="aspect-[9/16] w-full rounded-md border border-dashed bg-muted/40 flex flex-col items-center justify-center text-center text-xs text-muted-foreground p-2">
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
    <span className="rounded-full border border-border/60 bg-secondary/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
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
                  versión: <code className="rounded bg-muted px-1 text-xs">{stats.codeVersion}</code>
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(stats.porVault).map(([k, v]) => (
                <span key={k} className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs">
                  vault {k}: <strong>{v}</strong>
                </span>
              ))}
              {Object.entries(stats.porSubsistema)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span key={k} className="rounded bg-muted px-2 py-0.5 text-xs">
                    {k}: {v}
                  </span>
                ))}
            </div>
          </div>
        )}

        {tiposOrdenados.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Filtrar por tipo:</span>
            {tiposOrdenados.map(([tipo, count]) => (
              <button
                key={tipo}
                onClick={() => applyTipo(tipo)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
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
                className="rounded px-2 py-0.5 text-xs text-muted-foreground underline hover:text-foreground"
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
                    <span className="text-muted-foreground text-xs">{fmtTs(ev.ts)}</span>
                    <code className="rounded bg-muted px-1 text-xs">
                      {ev.subsistema}/{ev.tipo}
                    </code>
                    {ev.severidad && ev.severidad !== 'info' && (
                      <span className={`rounded px-1.5 py-0.5 text-xs ${severityClass(ev.severidad)}`}>
                        {ev.severidad}
                      </span>
                    )}
                    {ev.estado && (
                      <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-300">
                        {ev.estado}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{ev.fuente}</span>
                  </div>
                  <p className="mt-1">{ev.titulo}</p>
                  {ent && <p className="mt-0.5 text-xs text-muted-foreground">{ent}</p>}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Auditoría profunda on-demand (Fase 2) ───────────────────────────────────

interface HallazgoView {
  id: string;
  auditId: string;
  ts: string;
  subsistema: string;
  severidad: string;
  estado: string;
  titulo: string;
  descripcion: string;
  evidencia: string;
  fixPropuesto: string;
  confianza: number;
  verificacion?: { veredicto: string; razon: string };
}

interface SintesisView {
  resumenEjecutivo: string;
  topHallazgos: Array<{ titulo: string; severidad: string; porQueImporta: string }>;
  proximoPaso: string;
}

interface AuditReportView {
  auditId: string;
  subsistemasAuditados: string[];
  subsistemasSalteados: string[];
  hallazgos: HallazgoView[];
  descartados: number;
  sintesis: SintesisView | null;
  llamadas: number;
  errores: string[];
}

interface LastReportView {
  ts: string;
  depth: string;
  subsistemasAuditados: string[];
  totalHallazgos: number;
  descartados: number;
  sintesis: SintesisView | null;
}

interface AutoStatusView {
  enabled: boolean;
  source?: string;
  every: number;
  maxHours: number;
  runsDesdeUltima: number;
  ultimaTs: string | null;
}

function KnowledgeAuditSection() {
  const [findings, setFindings] = useState<HallazgoView[]>([]);
  const [report, setReport] = useState<AuditReportView | null>(null);
  const [lastReport, setLastReport] = useState<LastReportView | null>(null);
  const [auto, setAuto] = useState<AutoStatusView | null>(null);
  const [loading, setLoading] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [error, setError] = useState('');
  const [depth, setDepth] = useState<'rapido' | 'profundo'>('rapido');
  const [togglingAuto, setTogglingAuto] = useState(false);

  async function toggleAuto() {
    if (!auto) return;
    setTogglingAuto(true);
    try {
      const r = await fetch('/api/admin/kb/auto-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !auto.enabled }),
      });
      const data = (await r.json()) as { auto?: AutoStatusView; error?: string };
      if (r.ok && data.auto) setAuto(data.auto);
      else if (data.error) setError(data.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTogglingAuto(false);
    }
  }

  async function loadFindings() {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/kb/audit?limit=50', { cache: 'no-store' });
      const data = (await r.json()) as {
        hallazgos?: HallazgoView[];
        lastReport?: LastReportView | null;
        auto?: AutoStatusView | null;
        error?: string;
      };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setFindings(data.hallazgos ?? []);
      setLastReport(data.lastReport ?? null);
      setAuto(data.auto ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runAudit() {
    setAuditing(true);
    setError('');
    setReport(null);
    try {
      const r = await fetch('/api/admin/kb/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depth }),
      });
      const data = (await r.json()) as (AuditReportView & { error?: string });
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setReport(data);
      await loadFindings();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAuditing(false);
    }
  }

  useEffect(() => {
    void loadFindings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">🧪 Consejo de mejora continua</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Unos <strong>agentes especialistas</strong> revisan a fondo la actividad registrada
              (uno por subsistema), un <strong>verificador</strong> descarta los falsos positivos y
              una <strong>IA superior</strong> sintetiza. Corre solo de forma agrupada o cuando lo
              pidas. <strong>Nada se aplica solo</strong>: te propone, tú decides.
            </p>
            {auto && (
              <div className="mt-2 space-y-1.5 rounded-md border border-amber-500/20 bg-background/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    Análisis automático:{' '}
                    {auto.enabled ? (
                      <span className="text-emerald-600 dark:text-emerald-400">ENCENDIDO</span>
                    ) : (
                      <span className="text-muted-foreground">APAGADO</span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant={auto.enabled ? 'outline' : 'default'}
                    disabled={togglingAuto}
                    onClick={toggleAuto}
                  >
                    {togglingAuto ? '…' : auto.enabled ? 'Apagar' : 'Encender'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Si lo enciendes, el Consejo revisa la herramienta <strong>solo</strong>, de forma
                  agrupada (cada {auto.every} videos o cada {auto.maxHours}h), y deja sus hallazgos
                  aquí abajo. Cuesta algunas llamadas a la IA. <strong>Nada se aplica solo</strong> —
                  solo te avisa.
                  {auto.enabled && (
                    <>
                      {' '}
                      Acumulados {auto.runsDesdeUltima}/{auto.every}
                      {auto.ultimaTs ? ` · último análisis ${fmtTs(auto.ultimaTs)}` : ''}.
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex gap-1">
              {(['rapido', 'profundo'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDepth(d)}
                  disabled={auditing}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    depth === d ? 'bg-amber-600 text-white' : 'bg-background/60 text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {d === 'rapido' ? 'Rápido' : 'Profundo'}
                </button>
              ))}
            </div>
            <Button
              onClick={runAudit}
              disabled={auditing}
              size="sm"
              className="bg-amber-600 hover:bg-amber-700"
            >
              {auditing ? 'Auditando… (tarda)' : '🔍 Auditar a fondo'}
            </Button>
          </div>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        {report && (
          <div className="space-y-2 rounded-md border border-amber-500/20 bg-background/50 p-3 text-xs">
            <p className="text-xs text-muted-foreground">
              Auditados: {report.subsistemasAuditados.join(', ') || '—'}
              {report.subsistemasSalteados.length > 0 && (
                <> · salteados (sin cambios): {report.subsistemasSalteados.join(', ')}</>
              )}
              {' · '}falsos positivos descartados: {report.descartados} · llamadas IA: {report.llamadas}
            </p>
            {report.sintesis ? (
              <div className="space-y-1.5">
                <p className="font-semibold">Síntesis</p>
                <p>{report.sintesis.resumenEjecutivo}</p>
                {report.sintesis.proximoPaso && (
                  <p className="text-muted-foreground">
                    <strong>Próximo paso:</strong> {report.sintesis.proximoPaso}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Sin hallazgos esta vez (o subsistemas salteados por estar sin cambios). Es una buena
                señal.
              </p>
            )}
            {report.errores.length > 0 && (
              <p className="text-xs text-orange-600 dark:text-orange-400">
                Avisos: {report.errores.join(' · ')}
              </p>
            )}
          </div>
        )}

        {!report && lastReport && lastReport.sintesis && (
          <div className="space-y-2 rounded-md border border-amber-500/20 bg-background/50 p-3 text-xs">
            <p className="font-semibold">
              Último informe del Consejo{' '}
              <span className="font-normal text-muted-foreground">
                · {fmtTs(lastReport.ts)} · {lastReport.subsistemasAuditados.join(', ') || '—'}
              </span>
            </p>
            <p>{lastReport.sintesis.resumenEjecutivo}</p>
            {lastReport.sintesis.proximoPaso && (
              <p className="text-muted-foreground">
                <strong>Próximo paso:</strong> {lastReport.sintesis.proximoPaso}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {loading ? 'Cargando hallazgos…' : `${findings.length} hallazgo${findings.length === 1 ? '' : 's'} registrado${findings.length === 1 ? '' : 's'}`}
          </p>
        </div>

        {findings.length > 0 && (
          <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
            {Object.entries(
              findings.reduce<Record<string, HallazgoView[]>>((acc, h) => {
                (acc[h.subsistema] ??= []).push(h);
                return acc;
              }, {}),
            )
              .sort((a, b) => b[1].length - a[1].length)
              .map(([sub, items]) => (
                <div key={sub} className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {sub} <span className="font-normal">({items.length})</span>
                  </p>
                  {items.map((h) => (
                    <AuditFindingCard key={h.id} h={h} />
                  ))}
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditFindingCard({ h }: { h: HallazgoView }) {
  return (
    <div className="rounded-md border border-amber-500/15 bg-background/60 p-2.5 text-xs space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${severityClass(h.severidad)}`}>
          {h.severidad}
        </span>
        <code className="rounded bg-muted px-1 text-xs">{h.subsistema}</code>
        <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-300">
          {h.estado}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          confianza {Math.round((h.confianza ?? 0) * 100)}%
        </span>
      </div>
      <p className="font-medium">{h.titulo}</p>
      <p className="text-muted-foreground">{h.descripcion}</p>
      {h.fixPropuesto && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Fix propuesto + evidencia →
          </summary>
          <div className="mt-1 space-y-1">
            <p>
              <strong className="text-muted-foreground">Fix:</strong> {h.fixPropuesto}
            </p>
            {h.evidencia && (
              <p>
                <strong className="text-muted-foreground">Evidencia:</strong> {h.evidencia}
              </p>
            )}
            {h.verificacion && (
              <p>
                <strong className="text-muted-foreground">Verificación:</strong>{' '}
                {h.verificacion.veredicto} — {h.verificacion.razon}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── Receptor central: costo-eficiencia por instalación (Feature 2, owner) ────

interface InstallCostView {
  instalacion: string;
  videos: number;
  gastoTotalUsd: number;
  costoPromedioUsd: number;
  ultimoTs: string | null;
}

function CentralCostSection() {
  const [stats, setStats] = useState<InstallCostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/central', { cache: 'no-store' });
      const data = (await r.json()) as { stats?: InstallCostView[]; error?: string };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setStats(data.stats ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmtUsd = (n: number) => `$${n.toFixed(3)}`;

  return (
    <Card className="border-cyan-500/30 bg-cyan-500/5">
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">📊 Costo por usuario (cross-instalación)</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Gasto agregado por instalación (empleado), de lo que cada una sincroniza al buzón
              central. Ordenado por <strong>costo-eficiencia</strong> (menor costo por video
              primero). El costo es un <strong>estimado</strong> del pipeline — sirve para
              comparar, no como cifra exacta al centavo.
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

        {stats.length === 0 ? (
          <p className="rounded-md border border-dashed bg-background/30 p-4 text-center text-xs text-muted-foreground">
            {loading
              ? 'Cargando…'
              : 'Sin datos todavía. Aparecerán cuando una instalación con la sincronización activada (VF_LEARNING_SYNC_URL) envíe sus eventos a este receptor (VF_SYNC_INGEST_KEY).'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Instalación</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Videos</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Gasto total</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Costo / video</th>
                  <th className="py-1.5 font-medium text-right">Último</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s, i) => (
                  <tr key={s.instalacion} className="border-t border-cyan-500/10">
                    <td className="py-1.5 pr-3">
                      {i === 0 && (
                        <span className="mr-1" title="Más costo-eficiente">
                          🏆
                        </span>
                      )}
                      <code className="rounded bg-muted px-1 text-xs">{s.instalacion}</code>
                    </td>
                    <td className="py-1.5 pr-3 text-right">{s.videos}</td>
                    <td className="py-1.5 pr-3 text-right">{fmtUsd(s.gastoTotalUsd)}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold">
                      {fmtUsd(s.costoPromedioUsd)}
                    </td>
                    <td className="py-1.5 text-right text-xs text-muted-foreground">
                      {s.ultimoTs ? s.ultimoTs.slice(0, 10) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
              del bloque afectado. Tú apruebas o rechazas. Si apruebas, el patch se aplica al archivo
              source (NO commit automático). Reinicia el dev server para que tome efecto.
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
            Sin patches propuestos. Pulsa "Escanear patrones" para que el sistema busque errores
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
                  <span className="rounded bg-purple-500/20 px-2 py-0.5 font-semibold uppercase tracking-wide text-xs text-purple-700 dark:text-purple-300">
                    {p.pattern.category}
                  </span>
                  <span className="text-muted-foreground">→</span>
                  <code className="rounded bg-muted px-1 text-xs">{p.pattern.affectedBlock}</code>
                  <span className="text-muted-foreground">
                    {p.pattern.occurrenceCount} runs · severity {p.pattern.severityScore.toFixed(1)}
                  </span>
                  <span className="ml-auto">
                    confidence <strong>{p.confidence}/100</strong>
                  </span>
                </div>

                <p className="italic text-muted-foreground">{p.pattern.description}</p>

                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Ver patch propuesto ({p.patchType}) →
                    <code className="ml-1 text-xs">
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
                        <pre className="overflow-x-auto rounded bg-red-500/10 p-2 text-xs whitespace-pre-wrap">
                          {p.oldText}
                        </pre>
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-green-600 dark:text-green-400">
                        + Con:
                      </p>
                      <pre className="overflow-x-auto rounded bg-green-500/10 p-2 text-xs whitespace-pre-wrap">
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
