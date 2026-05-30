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

type State = 'idle' | 'working' | 'done' | 'error';

export function ZapCapSubtitles({ runId }: { runId: string }) {
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE);
  const [uppercase, setUppercase] = useState(true);
  const [state, setState] = useState<State>('idle');
  const [msg, setMsg] = useState('');

  async function generate() {
    setState('working');
    setMsg('Subiendo el video a ZapCap y generando subtítulos… puede tardar ~1-3 min.');
    try {
      const r = await fetch(`/api/runs/${runId}/subtitles/zapcap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, fontUppercase: uppercase }),
      });
      const j = (await r.json()) as { error?: string; message?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setState('done');
      setMsg(j.message || '¡Listo! Descarga tu video con subtítulos.');
    } catch (e) {
      setState('error');
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="text-sm font-medium">✨ Subtítulos automáticos (ZapCap)</div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          Estilo:
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={state === 'working'}
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
            disabled={state === 'working'}
          />
          MAYÚSCULAS
        </label>
        <button
          onClick={generate}
          disabled={state === 'working'}
          className={cn(buttonVariants({ variant: 'default' }))}
        >
          {state === 'working' ? 'Generando…' : 'Generar subtítulos'}
        </button>
        {state === 'done' ? (
          <a
            href={`/api/runs/${runId}/subtitles/zapcap`}
            className={cn(buttonVariants({ variant: 'outline' }))}
          >
            ⬇ Descargar video con subtítulos
          </a>
        ) : null}
      </div>
      {msg ? (
        <div className={cn('text-xs', state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {msg}
        </div>
      ) : null}
    </div>
  );
}
