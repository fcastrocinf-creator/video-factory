'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';

interface ProductDraft {
  id: string;
  name: string;
  description: string;
  dimensions: string;
}

// Voces preconfiguradas que puedes elegir directo desde el dropdown. Si ninguna
// te sirve, usa "Custom" y pega el voiceId de ElevenLabs.
const VOICE_PRESETS: Array<{
  label: string;
  voiceId: string;
  gender: 'male' | 'female' | 'neutral';
  ageRange: string;
  description: string;
}> = [
  {
    label: 'David · Energético, profundo (masculino)',
    voiceId: 'qRUgOhnxGASxirG4fKjv',
    gender: 'male',
    ageRange: '30-45',
    description: 'Voz energética, profunda y agradable en español neutro. Ideal para anuncios con autoridad.',
  },
  {
    label: 'Daniel · Voz masculina cálida adulta',
    voiceId: 'onwK4e9ZLuTAKqWW03F9',
    gender: 'male',
    ageRange: '30-45',
    description: 'Cálida, adulta, conversacional.',
  },
  {
    label: 'George · Masculina madura autoritativa',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    gender: 'male',
    ageRange: '45-60',
    description: 'Madura, con autoridad técnica.',
  },
  {
    label: 'Amiga chismosa (femenino)',
    voiceId: 'hpp4J3VqNfWAUOO0d1Us',
    gender: 'female',
    ageRange: '30-45',
    description: 'Tono femenino cercano, conversacional, ritmo rápido.',
  },
  {
    label: 'Custom (pega un voiceId)',
    voiceId: '',
    gender: 'neutral',
    ageRange: '30-45',
    description: 'Usa cualquier voiceId de tu cuenta de ElevenLabs.',
  },
];

export function CreateBrandForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Campos básicos
  const [brandId, setBrandId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState('es');

  // Productos (mínimo 1)
  const [products, setProducts] = useState<ProductDraft[]>([
    { id: '', name: '', description: '', dimensions: '' },
  ]);

  // Voz default
  const [voicePresetIdx, setVoicePresetIdx] = useState(0);
  const [customVoiceId, setCustomVoiceId] = useState('');

  // Colores de marca (CSV de hex codes)
  const [brandColorsCsv, setBrandColorsCsv] = useState('');

  // Tone rules
  const [tonePrefer, setTonePrefer] = useState('');
  const [toneAvoid, setToneAvoid] = useState('');

  function updateProduct(idx: number, patch: Partial<ProductDraft>) {
    setProducts((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addProduct() {
    setProducts((prev) => [...prev, { id: '', name: '', description: '', dimensions: '' }]);
  }
  function removeProduct(idx: number) {
    setProducts((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  // Auto-suggest brandId desde displayName (slug)
  function syncBrandIdFromName(name: string) {
    setDisplayName(name);
    if (!brandId) {
      const slug = name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      if (slug) setBrandId(slug);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // Validación cliente
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(brandId)) {
      setError('id inválido: usa minúsculas, números y guiones (3-41 chars). Ej: "mi-marca-2"');
      return;
    }
    if (!displayName.trim()) {
      setError('Nombre para mostrar requerido');
      return;
    }
    const cleanProducts = products
      .map((p) => ({
        id: p.id.trim(),
        name: p.name.trim(),
        description: p.description.trim(),
        dimensions: p.dimensions.trim(),
      }))
      .filter((p) => p.name || p.description);
    if (cleanProducts.length === 0) {
      setError('Agrega al menos 1 producto con nombre y descripción');
      return;
    }
    for (const p of cleanProducts) {
      if (!p.id) {
        setError(`Producto "${p.name}" sin id. Usa formato como "mi-producto"`);
        return;
      }
      if (!p.name || !p.description) {
        setError('Cada producto necesita nombre y descripción');
        return;
      }
    }

    const preset = VOICE_PRESETS[voicePresetIdx]!;
    const voiceId = preset.voiceId || customVoiceId.trim();
    if (!voiceId) {
      setError('Elige una voz o pega un voiceId de ElevenLabs');
      return;
    }

    const brandColors = brandColorsCsv
      .split(',')
      .map((c) => c.trim())
      .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));

    const prefer = tonePrefer.split('\n').map((s) => s.trim()).filter(Boolean);
    const avoid = toneAvoid.split('\n').map((s) => s.trim()).filter(Boolean);

    const payload = {
      id: brandId,
      displayName: displayName.trim(),
      language,
      products: cleanProducts.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        ...(p.dimensions ? { dimensions: p.dimensions } : {}),
      })),
      defaultVoice: {
        voiceId,
        modelId: 'eleven_multilingual_v2',
        stability: 0.5,
        similarity: 0.75,
        style: 0.3,
        speakerBoost: true,
        speedMultiplier: 1.0,
        gender: preset.gender,
        ageRange: preset.ageRange,
        label: preset.label === 'Custom (pega un voiceId)' ? 'Custom' : preset.label,
      },
      brandColors,
      toneRules: { prefer, avoid },
    };

    setSubmitting(true);
    try {
      const resp = await fetch('/api/brands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      // Redirige al edit ingredients de la marca recién creada
      router.push(`/brands/${brandId}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  const selectedPreset = VOICE_PRESETS[voicePresetIdx]!;

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} className="space-y-6">
          {/* === BÁSICOS === */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Identidad de la marca
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Nombre para mostrar</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => syncBrandIdFromName(e.target.value)}
                  placeholder="Ej: Vitaly · Suplementos"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brandId">ID interno</Label>
                <Input
                  id="brandId"
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  placeholder="vitaly-suplementos"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Minúsculas, números y guiones. Único, no se puede cambiar después.
                </p>
              </div>
            </div>
            <div className="space-y-1.5 max-w-xs">
              <Label htmlFor="language">Idioma principal</Label>
              <Select
                id="language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="es">Español neutro (es)</option>
                <option value="es-CL">Español de Chile (es-CL)</option>
                <option value="es-MX">Español de México (es-MX)</option>
                <option value="es-ES">Español de España (es-ES)</option>
                <option value="en">Inglés (en)</option>
                <option value="pt">Portugués (pt)</option>
              </Select>
            </div>
          </section>

          {/* === PRODUCTOS === */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Productos ({products.length})
            </h2>
            <p className="text-xs text-muted-foreground">
              Cada producto necesita un id único (ej: &ldquo;vitaly-gotas&rdquo;), un nombre y
              una descripción que la IA usará para reconocerlo en los videos.
            </p>
            <div className="space-y-3">
              {products.map((p, idx) => (
                <div key={idx} className="rounded-md border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Producto {idx + 1}</span>
                    {products.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeProduct(idx)}
                        className="text-xs text-destructive hover:underline"
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Nombre</Label>
                      <Input
                        value={p.name}
                        onChange={(e) => updateProduct(idx, { name: e.target.value })}
                        placeholder="Ej: Vitaly Gotas Drenaje Linfático"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">ID interno</Label>
                      <Input
                        value={p.id}
                        onChange={(e) => updateProduct(idx, { id: e.target.value })}
                        placeholder="vitaly-gotas"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Descripción</Label>
                    <Textarea
                      value={p.description}
                      onChange={(e) => updateProduct(idx, { description: e.target.value })}
                      placeholder="Ej: Suplemento líquido para drenaje linfático, frasco gotero ámbar de 30ml con etiqueta amarilla."
                      rows={2}
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Dimensiones (opcional)</Label>
                    <Input
                      value={p.dimensions}
                      onChange={(e) => updateProduct(idx, { dimensions: e.target.value })}
                      placeholder="Ej: 12cm de alto, frasco gotero ámbar"
                    />
                  </div>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addProduct}>
              + Agregar producto
            </Button>
          </section>

          {/* === VOZ === */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Voz por defecto (ElevenLabs)
            </h2>
            <p className="text-xs text-muted-foreground">
              La voz que se usa por defecto. Después puedes agregar más voces a la{' '}
              <em>voice library</em> de la marca editando el archivo JSON o desde la
              UI de edición.
            </p>
            <div className="space-y-2">
              <Select
                value={String(voicePresetIdx)}
                onChange={(e) => setVoicePresetIdx(Number(e.target.value))}
              >
                {VOICE_PRESETS.map((v, i) => (
                  <option key={i} value={i}>
                    {v.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{selectedPreset.description}</p>
              {voicePresetIdx === VOICE_PRESETS.length - 1 && (
                <div className="space-y-1 pt-1">
                  <Label className="text-xs">VoiceId de ElevenLabs</Label>
                  <Input
                    value={customVoiceId}
                    onChange={(e) => setCustomVoiceId(e.target.value)}
                    placeholder="Ej: 21m00Tcm4TlvDq8ikWAM"
                  />
                </div>
              )}
            </div>
          </section>

          {/* === COLORES === */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Paleta principal (opcional)
            </h2>
            <div className="space-y-1.5">
              <Label htmlFor="brandColors">Colores de marca (hex, separados por coma)</Label>
              <Input
                id="brandColors"
                value={brandColorsCsv}
                onChange={(e) => setBrandColorsCsv(e.target.value)}
                placeholder="#FFE600, #F5F2ED, #1A1A1A"
              />
              <p className="text-xs text-muted-foreground">
                Formato hex de 6 dígitos. La paleta completa con nombres semánticos
                se configura desde <em>Editar ingredients</em> de la marca.
              </p>
              {brandColorsCsv && (
                <div className="flex gap-1.5 pt-1">
                  {brandColorsCsv
                    .split(',')
                    .map((c) => c.trim())
                    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
                    .map((c) => (
                      <div
                        key={c}
                        className="h-6 w-6 rounded border"
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                </div>
              )}
            </div>
          </section>

          {/* === TONE RULES === */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Reglas de tono (opcional)
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="prefer">Preferir (una por línea)</Label>
                <Textarea
                  id="prefer"
                  value={tonePrefer}
                  onChange={(e) => setTonePrefer(e.target.value)}
                  placeholder="español neutro&#10;tono conversacional&#10;ejemplos concretos"
                  rows={4}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="avoid">Evitar (una por línea)</Label>
                <Textarea
                  id="avoid"
                  value={toneAvoid}
                  onChange={(e) => setToneAvoid(e.target.value)}
                  placeholder="voseo argentino&#10;claims médicos absolutos&#10;superlativos exagerados"
                  rows={4}
                  className="text-xs"
                />
              </div>
            </div>
          </section>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}

          <div className="flex gap-2 justify-end pt-2 border-t">
            <Button type="submit" disabled={submitting} size="lg">
              {submitting ? 'Creando…' : 'Crear marca'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
