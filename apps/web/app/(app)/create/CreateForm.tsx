'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

interface BrandOption {
  id: string;
  displayName: string;
}
interface PresetOption {
  id: string;
  displayName: string;
  description: string;
  estrategia: string;
}

export interface CreateFormProps {
  brands: BrandOption[];
  presets: PresetOption[];
}

export function CreateForm({ brands, presets }: CreateFormProps) {
  const router = useRouter();
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [presetId, setPresetId] = useState(presets[0]?.id ?? '');
  const [script, setScript] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selectedPreset = presets.find((p) => p.id === presetId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (script.trim().length < 10) {
      setError('El guión debe tener al menos 10 caracteres.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brandId, presetId, script }),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) {
        setError(data.error ?? 'Error al crear el run');
        return;
      }
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="brand">Marca</Label>
              <Select id="brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="preset">Preset</Label>
              <Select id="preset" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {selectedPreset && (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {selectedPreset.description}
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="script">Guión</Label>
            <Textarea
              id="script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Pegá acá el guión completo. Usá … (U+2026) para pausas largas y . ? ! para pausas naturales."
              rows={14}
              className="font-mono text-sm"
              required
            />
            <p className="text-xs text-muted-foreground">
              {wordCount(script)} palabras · ~{estimateSeconds(script)} segundos estimados
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} size="lg" className="w-full">
            {submitting ? 'Disparando pipeline...' : 'Generar video'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function estimateSeconds(text: string): number {
  // 2.5 palabras/segundo, redondeo al entero más cercano.
  return Math.round(wordCount(text) / 2.5);
}
