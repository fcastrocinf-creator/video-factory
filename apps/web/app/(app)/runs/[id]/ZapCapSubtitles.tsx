'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

const TEMPLATES = [
  { id: 'decf5309-2094-4257-a646-cabe1f1ba89a', name: 'Hormozi 3 (animado, viral)' },
  { id: 'e7e758de-4eb4-460f-aeca-b2801ac7f8cc', name: 'Ella (animado)' },
  { id: '982ad276-a76f-4d80-a4e2-b8fae0038464', name: 'Luke (limpio)' },
  { id: '07ffd4b8-4e1a-4ee3-8921-d58802953bcd', name: 'Celine' },
  { id: '7b946549-ae16-4085-9dd3-c20c82504daa', name: 'Maya' },
];
const DEFAULT_TEMPLATE = 'decf5309-2094-4257-a646-cabe1f1ba89a';

interface Line {
  index: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
}
type ZapState = 'idle' | 'working' | 'done' | 'error';

function srtTime(sec: number): string {
  const s = Math.max(0, sec);
  const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)},${String(ms).padStart(3, '0')}`;
}

export function ZapCapSubtitles({ runId }: { runId: string }) {
  const [shown, setShown] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE);
  const [uppercase, setUppercase] = useState(true);
  const [zap, setZap] = useState<ZapState>('idle');
  const [zapMsg, setZapMsg] = useState('');

  async function openEditor() {
    setShown(true);
    if (lines) return;
    try {
      const r = await fetch(`/api/runs/${runId}/subtitles?json=1`);
      const j = (await r.json()) as { lines?: Line[]; error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setLines(j.lines ?? []);
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }

  function editLine(i: number, text: string) {
    setLines((prev) => (prev ? prev.map((l, idx) => (idx === i ? { ...l, text } : l)) : prev));
  }

  function downloadSrt() {
    if (!lines) return;
    const srt = lines
      .map((l, i) => `${i + 1}\n${srtTime(l.startTimeSeconds)} --> ${srtTime(l.endTimeSeconds)}\n${l.text}\n`)
      .join('\n');
    const url = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitulos-${runId.slice(0, 8)}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function generateZapcap() {
    setZap('working');
    setZapMsg('Subiendo a ZapCap y generando subtítulos… ~1-3 min.');
    try {
      const r = await fetch(`/api/runs/${runId}/subtitles/zapcap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, fontUppercase: uppercase }),
      });
      const j = (await r.json()) as { error?: string; message?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setZap('done');
      setZapMsg(j.message || '¡Listo! Descarga tu video con subtítulos.');
    } catch (e) {
      setZap('error');
      setZapMsg((e as Error).message);
    }
  }

  if (!shown) {
    return (
      <button onClick={openEditor} className={cn(buttonVariants({ variant: 'outline' }))}>
        💬 Agregar subtítulos
      </button>
    );
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="text-sm font-medium">💬 Subtítulos del video</div>

      {/* Script editable */}
      {loadErr ? (
        <div className="text-xs text-destructive">No se pudo cargar el script: {loadErr}</div>
      ) : !lines ? (
        <div className="text-xs text-muted-foreground">Cargando el script…</div>
      ) : lines.length === 0 ? (
        <div className="text-xs text-muted-foreground">Este video no tiene texto de guion.</div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Tu guion (puedes corregir cualquier palabra antes de generar):
          </div>
          {lines.map((l, i) => (
            <div key={l.index} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {l.startTimeSeconds.toFixed(1)}s
              </span>
              <input
                value={l.text}
                onChange={(e) => editLine(i, e.target.value)}
                className="w-full rounded border bg-background px-2 py-1 text-sm"
              />
            </div>
          ))}
          <button onClick={downloadSrt} className={cn(buttonVariants({ variant: 'default' }), 'mt-1')}>
            ⬇ Descargar .srt (con tus ediciones)
          </button>
          <p className="text-xs text-muted-foreground">
            El .srt sale con tu texto exacto — impórtalo en CapCut o ZapCap para ponerle el estilo.
          </p>
        </div>
      )}

      {/* Generar estilizado con ZapCap */}
      <div className="space-y-2 border-t pt-3">
        <div className="text-sm font-medium">✨ O genera el video estilizado directo (ZapCap)</div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Estilo:
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={zap === 'working'}
              className="rounded border bg-background px-2 py-1"
            >
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={uppercase}
              onChange={(e) => setUppercase(e.target.checked)}
              disabled={zap === 'working'}
            />
            MAYÚSCULAS
          </label>
          <button
            onClick={generateZapcap}
            disabled={zap === 'working'}
            className={cn(buttonVariants({ variant: 'default' }))}
          >
            {zap === 'working' ? 'Generando…' : 'Generar video con subtítulos'}
          </button>
          {zap === 'done' ? (
            <a
              href={`/api/runs/${runId}/subtitles/zapcap`}
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              ⬇ Descargar video con subtítulos
            </a>
          ) : null}
        </div>
        {zapMsg ? (
          <div className={cn('text-xs', zap === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
            {zapMsg}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Nota: por ahora ZapCap transcribe del audio (puede errar alguna palabra). Para texto exacto,
          usa el .srt de arriba.
        </p>
      </div>
    </div>
  );
}
