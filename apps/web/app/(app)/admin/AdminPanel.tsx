'use client';

import { useState, useTransition } from 'react';
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
