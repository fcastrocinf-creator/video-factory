'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { ClaudeChatPanel } from '@/components/ClaudeChatPanel';

interface VoiceOption {
  voiceId: string;
  label: string;
  gender: 'male' | 'female' | 'neutral';
  ageRange: string;
}
interface BrandOption {
  id: string;
  displayName: string;
  products: Array<{ id: string; name: string }>;
  voices: VoiceOption[];
}
interface PresetOption {
  id: string;
  displayName: string;
  description: string;
  estrategia: string;
  visualEngine: string;
  categoryId?: string;
  categoryDisplayName?: string;
  categoryDescription?: string;
  formatId?: string;
  formatDisplayName?: string;
  formatDescription?: string;
  styleId?: string;
  styleDisplayName?: string;
}

export interface CreateFormProps {
  brands: BrandOption[];
  presets: PresetOption[];
}

const AUTO = '__auto__';

export function CreateForm({ brands, presets }: CreateFormProps) {
  const router = useRouter();
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');

  // Categorías únicas extraídas de los presets disponibles
  const categories = useMemo(() => {
    const seen = new Map<string, { id: string; displayName: string; description: string }>();
    for (const p of presets) {
      if (p.categoryId && !seen.has(p.categoryId)) {
        seen.set(p.categoryId, {
          id: p.categoryId,
          displayName: p.categoryDisplayName ?? p.categoryId,
          description: p.categoryDescription ?? '',
        });
      }
    }
    return Array.from(seen.values());
  }, [presets]);

  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');

  // Formatos disponibles para la categoría actual (B-ROLL Estático, Animado, UGC B-ROLL, UGC Testimonio)
  const formatsForCategory = useMemo(() => {
    const seen = new Map<string, { id: string; displayName: string; description: string }>();
    for (const p of presets) {
      if (p.categoryId === categoryId && p.formatId && !seen.has(p.formatId)) {
        seen.set(p.formatId, {
          id: p.formatId,
          displayName: p.formatDisplayName ?? p.formatId,
          description: p.formatDescription ?? '',
        });
      }
    }
    return Array.from(seen.values());
  }, [presets, categoryId]);

  const [formatId, setFormatId] = useState(formatsForCategory[0]?.id ?? '');

  // Si cambia categoría, resetear formato al primero disponible
  useEffect(() => {
    if (formatsForCategory.length > 0 && !formatsForCategory.some((f) => f.id === formatId)) {
      setFormatId(formatsForCategory[0]!.id);
    }
  }, [formatsForCategory, formatId]);

  // Estilos disponibles para la (categoría, formato) actual
  const stylesForCategoryFormat = useMemo(() => {
    return presets
      .filter((p) => p.categoryId === categoryId && p.formatId === formatId && p.styleId)
      .map((p) => ({
        id: p.styleId!,
        displayName: p.styleDisplayName ?? p.styleId!,
        presetId: p.id,
      }));
  }, [presets, categoryId, formatId]);

  const [styleId, setStyleId] = useState(stylesForCategoryFormat[0]?.id ?? '');

  // Si cambia (categoría, formato), resetear estilo al primero disponible
  useEffect(() => {
    if (
      stylesForCategoryFormat.length > 0 &&
      !stylesForCategoryFormat.some((s) => s.id === styleId)
    ) {
      setStyleId(stylesForCategoryFormat[0]!.id);
    }
  }, [stylesForCategoryFormat, styleId]);

  // Resolver presetId desde (categoryId, formatId, styleId)
  const selectedPreset = useMemo(() => {
    return presets.find(
      (p) => p.categoryId === categoryId && p.formatId === formatId && p.styleId === styleId,
    );
  }, [presets, categoryId, formatId, styleId]);

  // Presets "huérfanos" (sin category/style) los listamos en una categoría "Otros"
  const orphanPresets = useMemo(() => presets.filter((p) => !p.categoryId), [presets]);
  const isOrphanCategory = categoryId === '__orphan__';
  const [orphanPresetId, setOrphanPresetId] = useState(orphanPresets[0]?.id ?? '');

  // Presets "aprendidos" (generados desde un análisis de Ripear). Aparecen como
  // una categoría especial "🧠 Aprendidos del Ripeo" con preview GIF visible.
  const learnedPresets = useMemo(
    () => presets.filter((p) => p.id.startsWith('learned-')),
    [presets],
  );
  const isLearnedCategory = categoryId === '__learned__';
  const [learnedPresetId, setLearnedPresetId] = useState(learnedPresets[0]?.id ?? '');

  // Cuando se carga la lista (o cambia), si nuestro learnedPresetId ya no existe
  // (porque el user borró el preset), seteamos al primero disponible.
  useEffect(() => {
    if (learnedPresets.length > 0 && !learnedPresets.some((p) => p.id === learnedPresetId)) {
      setLearnedPresetId(learnedPresets[0]!.id);
    }
  }, [learnedPresets, learnedPresetId]);

  const effectivePreset = isLearnedCategory
    ? presets.find((p) => p.id === learnedPresetId)
    : isOrphanCategory
      ? presets.find((p) => p.id === orphanPresetId)
      : selectedPreset;

  const [voiceOverride, setVoiceOverride] = useState<string>(AUTO);
  const [productId, setProductId] = useState<string>('');
  const [script, setScript] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Parte 2 (a la carta): interruptores del video. Defaults = comportamiento actual.
  const [optVoice, setOptVoice] = useState(true);
  const [optSubtitles, setOptSubtitles] = useState(false);
  const [subtitlesTouched, setSubtitlesTouched] = useState(false);
  const [optAnimation, setOptAnimation] = useState(true);
  const [optKenBurns, setOptKenBurns] = useState(false);

  // Parte 3: previsualizar escenas + elegir cuáles parte en micro-escenas.
  const [previewScenes, setPreviewScenes] = useState<
    Array<{ index: number; text: string; componentType: string; isEnumeration: boolean }> | null
  >(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [microIndices, setMicroIndices] = useState<number[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Si cambia el guion, el preset o la marca, el preview anterior deja de ser
  // válido (sus escenas/índices ya no corresponden). Lo limpiamos.
  useEffect(() => {
    setPreviewScenes(null);
    setPreviewId(null);
    setMicroIndices([]);
    setPreviewError('');
  }, [script, effectivePreset?.id, brandId]);

  // Prefill desde /rip → "Usar este script en /create": leemos sessionStorage
  // una sola vez al montar y limpiamos la key para que no persista entre refreshes.
  // El payload es JSON: { script, brandId, presetId, productId }. Tambien aceptamos
  // string plano como fallback (compat) por si en algún momento se guarda asi.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('prefill-script');
      if (!raw || raw.trim().length === 0) return;
      sessionStorage.removeItem('prefill-script');
      // Intentamos parsear JSON; si falla, lo tratamos como script plano.
      let payload: {
        script?: string;
        brandId?: string;
        presetId?: string;
        productId?: string | null;
      };
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { script: raw };
      }
      if (payload.script && payload.script.trim().length > 0) {
        setScript(payload.script);
      }
      if (payload.brandId && brands.some((b) => b.id === payload.brandId)) {
        setBrandId(payload.brandId);
      }
      if (payload.productId !== undefined && payload.productId !== null) {
        setProductId(payload.productId);
      }
      // Si el preset existe, back-derivamos (category, format, style) para que
      // los selects queden alineados con la elección original.
      if (payload.presetId) {
        const p = presets.find((x) => x.id === payload.presetId);
        if (p) {
          if (p.categoryId) setCategoryId(p.categoryId);
          if (p.formatId) setFormatId(p.formatId);
          if (p.styleId) setStyleId(p.styleId);
        }
      }
      // Brief guiado del Copilot: aplicar las opciones a la carta si vinieron.
      const rawOpts = sessionStorage.getItem('prefill-options');
      if (rawOpts) {
        sessionStorage.removeItem('prefill-options');
        try {
          const o = JSON.parse(rawOpts) as {
            voice?: boolean;
            subtitles?: boolean;
            animation?: boolean;
            kenBurns?: boolean;
          };
          if (typeof o.voice === 'boolean') setOptVoice(o.voice);
          if (typeof o.subtitles === 'boolean') {
            setOptSubtitles(o.subtitles);
            setSubtitlesTouched(true);
          }
          if (typeof o.animation === 'boolean') setOptAnimation(o.animation);
          if (typeof o.kenBurns === 'boolean') setOptKenBurns(o.kenBurns);
        } catch {
          // opciones malformadas: ignorar.
        }
      }
    } catch {
      // sessionStorage puede no estar disponible (SSR, modo privado). Ignoramos.
    }
    // Solo corremos una vez al montar: brands/presets son estables (vienen del server).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedBrand = useMemo(() => brands.find((b) => b.id === brandId), [brands, brandId]);
  const voiceOptions = selectedBrand?.voices ?? [];
  const productOptions = selectedBrand?.products ?? [];

  // Si la marca cambia, resetear product al primero disponible (o vacío)
  useEffect(() => {
    if (productOptions.length === 0) {
      setProductId('');
    } else if (!productOptions.some((p) => p.id === productId)) {
      setProductId(productOptions[0]!.id);
    }
  }, [productOptions, productId]);

  async function handleSubmitWithMode(mode: 'auto' | 'collaborative') {
    if (script.trim().length < 10) {
      setError('El guión debe tener al menos 10 caracteres.');
      return;
    }
    if (!effectivePreset) {
      setError(
        'Combinación inválida de categoría + formato + estilo. Prueba con otra combinación: la matriz no cubre todos los cruces.',
      );
      return;
    }
    setSubmitting(true);
    try {
      const chosenVoice = voiceOptions.find((v) => v.voiceId === voiceOverride);
      const narratorGenderOverride =
        chosenVoice && chosenVoice.gender !== 'neutral' ? chosenVoice.gender : null;
      const payload = JSON.stringify({
        brandId,
        presetId: effectivePreset.id,
        productId: productId || null,
        script,
        voiceOverride: voiceOverride === AUTO ? null : voiceOverride,
        narratorGenderOverride,
        mode,
        voice: optVoice,
        subtitles: subtitlesTouched ? optSubtitles && optVoice : undefined,
        animation: optAnimation,
        kenBurns: optKenBurns,
        microSceneIndices: previewScenes ? microIndices : undefined,
        previewId: previewScenes ? previewId : undefined,
      });
      const data = await submitViaXhr('/api/generate', payload);
      if (!data.runId) {
        setError(data.error ?? 'Error al crear el run');
        return;
      }
      // v3.2 #119: si modo collaborative → redirigir al UI dedicado
      router.push(
        mode === 'collaborative' ? `/runs/${data.runId}/build` : `/runs/${data.runId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de red';
      const isExtensionBlock = /failed to fetch|chrome-extension|network error/i.test(msg);
      setError(
        isExtensionBlock
          ? `Error de red: ${msg}. Prueba deshabilitando extensiones de Chrome (especialmente bloqueadores de ads/trackers) o usar una ventana de incógnito.`
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (script.trim().length < 10) {
      setError('El guión debe tener al menos 10 caracteres.');
      return;
    }
    if (!effectivePreset) {
      setError(
        'Combinación inválida de categoría + formato + estilo. Prueba con otra combinación: la matriz no cubre todos los cruces.',
      );
      return;
    }
    setSubmitting(true);
    try {
      // narratorGenderOverride se infiere automáticamente de la voz elegida:
      // si voiceOverride es una voz específica, su gender domina al inferido.
      const chosenVoice = voiceOptions.find((v) => v.voiceId === voiceOverride);
      const narratorGenderOverride =
        chosenVoice && chosenVoice.gender !== 'neutral' ? chosenVoice.gender : null;

      const payload = JSON.stringify({
        brandId,
        presetId: effectivePreset.id,
        productId: productId || null,
        script,
        voiceOverride: voiceOverride === AUTO ? null : voiceOverride,
        narratorGenderOverride,
        voice: optVoice,
        subtitles: subtitlesTouched ? optSubtitles && optVoice : undefined,
        animation: optAnimation,
        kenBurns: optKenBurns,
        microSceneIndices: previewScenes ? microIndices : undefined,
        previewId: previewScenes ? previewId : undefined,
      });

      // Usamos XMLHttpRequest como fallback a fetch porque algunas extensiones de
      // Chrome (ej. frame_ant ID hoklmmgfnpapgjgcpechhaamimifchmp) interceptan
      // window.fetch y rompen la petición con "TypeError: Failed to fetch". XHR
      // no lo intercepta y funciona aunque el usuario tenga esas extensiones.
      const data = await submitViaXhr('/api/generate', payload);
      if (!data.runId) {
        setError(data.error ?? 'Error al crear el run');
        return;
      }
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de red';
      // Si el mensaje sugiere bloqueo por extensión, damos guía accionable
      const isExtensionBlock = /failed to fetch|chrome-extension|network error/i.test(msg);
      setError(
        isExtensionBlock
          ? `Error de red: ${msg}. Prueba deshabilitando extensiones de Chrome (especialmente bloqueadores de ads/trackers) o usar una ventana de incógnito.`
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePreview() {
    if (!effectivePreset || script.trim().length < 10) {
      setPreviewError('Elige el estilo y escribe el guión (mínimo 10 caracteres).');
      return;
    }
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const resp = await fetch('/api/plan-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandId, presetId: effectivePreset.id, script }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        previewId?: string;
        scenes?: Array<{ index: number; text: string; componentType: string; isEnumeration: boolean }>;
        error?: string;
      };
      if (!resp.ok || !data.scenes) {
        setPreviewError(data.error ?? `Error ${resp.status}`);
        setPreviewScenes(null);
        return;
      }
      setPreviewScenes(data.scenes);
      setPreviewId(data.previewId ?? null);
      setMicroIndices([]);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setPreviewLoading(false);
    }
  }

  function toggleMicro(index: number) {
    setMicroIndices((cur) => (cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index]));
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Fila 1: Marca + Categoría */}
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
              <Label htmlFor="category">Categoría narrativa</Label>
              <Select
                id="category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {learnedPresets.length > 0 && (
                  <option value="__learned__">🧠 Aprendidos del Ripeo ({learnedPresets.length})</option>
                )}
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
                {orphanPresets.length > 0 && <option value="__orphan__">Otros (sin clasificar)</option>}
              </Select>
              {isLearnedCategory ? (
                <p className="text-[11px] text-muted-foreground">
                  Estilos que el sistema aprendió analizando videos en{' '}
                  <a href="/rip" className="underline hover:text-foreground">/rip</a>.
                  Cada uno tiene preview del primer render que se hizo con él.
                </p>
              ) : (
                categories.find((c) => c.id === categoryId)?.description && (
                  <p className="text-[11px] text-muted-foreground">
                    {categories.find((c) => c.id === categoryId)!.description}
                  </p>
                )
              )}
            </div>
          </div>

          {/* Fila especial: dropdown directo + GIF preview cuando categoryId=__learned__ */}
          {isLearnedCategory && (
            <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-4 items-start">
              <div className="space-y-2">
                <Label htmlFor="learned-preset">Estilo aprendido</Label>
                <Select
                  id="learned-preset"
                  value={learnedPresetId}
                  onChange={(e) => setLearnedPresetId(e.target.value)}
                >
                  {learnedPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </Select>
                {effectivePreset && (
                  <p className="text-[11px] text-muted-foreground">
                    {effectivePreset.description}
                  </p>
                )}
              </div>
              {/* GIF preview del primer render hecho con este preset */}
              {effectivePreset && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Preview</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={effectivePreset.id}
                    src={`/api/presets/${effectivePreset.id}/preview`}
                    alt={`preview ${effectivePreset.displayName}`}
                    className="w-full aspect-[9/16] rounded-md border bg-muted object-cover"
                    onError={(e) => {
                      // Si no hay preview todavía (sin run completado), reemplazamos
                      // el src por un placeholder textual escondiéndolo elegantemente
                      const target = e.currentTarget;
                      target.style.display = 'none';
                      const placeholder = target.nextElementSibling as HTMLElement | null;
                      if (placeholder) placeholder.style.display = 'flex';
                    }}
                  />
                  <div
                    className="hidden aspect-[9/16] w-full flex-col items-center justify-center rounded-md border border-dashed bg-muted/40 p-2 text-center text-[11px] text-muted-foreground"
                  >
                    <span className="text-2xl">🎬</span>
                    <span className="mt-1">
                      Preview disponible después del primer render con este estilo
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Fila 2: Formato + Estilo Visual */}
          {!isOrphanCategory && !isLearnedCategory && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="format">Formato</Label>
                <Select
                  id="format"
                  value={formatId}
                  onChange={(e) => setFormatId(e.target.value)}
                  disabled={formatsForCategory.length === 0}
                >
                  {formatsForCategory.length === 0 ? (
                    <option value="">— sin formatos disponibles para esta categoría —</option>
                  ) : (
                    formatsForCategory.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.displayName}
                      </option>
                    ))
                  )}
                </Select>
                {formatsForCategory.find((f) => f.id === formatId)?.description && (
                  <p className="text-[11px] text-muted-foreground">
                    {formatsForCategory.find((f) => f.id === formatId)!.description}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="style">Estilo visual</Label>
                <Select
                  id="style"
                  value={styleId}
                  onChange={(e) => setStyleId(e.target.value)}
                  disabled={stylesForCategoryFormat.length === 0}
                >
                  {stylesForCategoryFormat.length === 0 ? (
                    <option value="">— sin estilos disponibles para este formato —</option>
                  ) : (
                    stylesForCategoryFormat.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName}
                      </option>
                    ))
                  )}
                </Select>
              </div>
            </div>
          )}

          {/* Fila 3: Voz (siempre visible) + (en orphan, dropdown directo de preset) */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="voice">Voz</Label>
              <Select
                id="voice"
                value={voiceOverride}
                onChange={(e) => setVoiceOverride(e.target.value)}
              >
                <option value={AUTO}>Auto — se infiere del guión</option>
                {voiceOptions.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.label}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Auto detecta gender del narrador y elige voz. Override para forzar manualmente.
              </p>
            </div>

            {isOrphanCategory && (
              <div className="space-y-2">
                <Label htmlFor="orphan-preset">Preset (sin categoría)</Label>
                <Select
                  id="orphan-preset"
                  value={orphanPresetId}
                  onChange={(e) => setOrphanPresetId(e.target.value)}
                >
                  {orphanPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {/* Producto (opcional, agrupa videos en el repositorio) */}
          {productOptions.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="product">Producto (opcional)</Label>
              <Select id="product" value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">Sin asignar — video general de la marca</option>
                {productOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Asignar un producto permite agrupar este video en el repositorio.
              </p>
            </div>
          )}

          {/* Descripción del preset resuelto */}
          {effectivePreset && (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <span className="font-semibold">{effectivePreset.displayName}</span>
              {' — '}
              {effectivePreset.description}
              <span className="mt-1 block opacity-70">
                Motor: <code>{effectivePreset.visualEngine}</code> · Estrategia:{' '}
                <code>{effectivePreset.estrategia}</code>
              </span>
            </p>
          )}

          {/* Guión */}
          <div className="space-y-2">
            <Label htmlFor="script">Guión</Label>
            <Textarea
              id="script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Pega aquí el guión completo. Usa … (U+2026) para pausas largas y . ? ! para pausas naturales."
              rows={14}
              className="font-mono text-sm"
              required
            />
            <p className="text-xs text-muted-foreground">
              {wordCount(script)} palabras · ~{estimateSeconds(script)} segundos estimados
            </p>
          </div>

          {/* M8: chat IA para refinar el script antes de disparar el pipeline */}
          <ClaudeChatPanel
            contextType="script-refine"
            contextData={{
              brandId,
              presetId: effectivePreset?.id,
              productId,
              scriptCurrent: script,
              wordCount: wordCount(script),
              estimatedSeconds: estimateSeconds(script),
              presetMeta: effectivePreset
                ? {
                    displayName: effectivePreset.displayName,
                    estrategia: effectivePreset.estrategia,
                    visualEngine: effectivePreset.visualEngine,
                  }
                : null,
            }}
            title="Discute el guion con Claude antes de generar"
            placeholder="Ej: '¿El hook es fuerte en los primeros 3 segundos?' o '¿El claim de Vitaly cumple con la FTC?'"
          />

          {/* Parte 2: opciones "a la carta" del video */}
          <div className="space-y-2">
            <Label>Opciones del video</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <OptionToggle label="Voz" desc="Narración hablada" checked={optVoice} onChange={setOptVoice} />
              <OptionToggle
                label="Subtítulos"
                desc={optVoice ? 'Texto sobre el video' : 'Requiere voz'}
                checked={optSubtitles && optVoice}
                onChange={(v) => {
                  setOptSubtitles(v);
                  setSubtitlesTouched(true);
                }}
                disabled={!optVoice}
              />
              <OptionToggle
                label="Animación"
                desc="Escenas en movimiento (si el estilo lo permite)"
                checked={optAnimation}
                onChange={setOptAnimation}
              />
              <OptionToggle
                label="Movimiento Ken Burns"
                desc="Zoom/paneo suave en estáticas"
                checked={optKenBurns}
                onChange={setOptKenBurns}
              />
            </div>
            {!optVoice && (
              <p className="text-[11px] text-muted-foreground">
                Sin voz, el video sale mudo y los subtítulos no aplican.
              </p>
            )}
          </div>

          {/* Parte 3: previsualizar escenas + elegir micro-escenas */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Escenas (opcional)</Label>
              <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={previewLoading}
                className="rounded-md border border-input px-3 py-1.5 text-xs transition-colors hover:bg-muted/40 disabled:opacity-50"
              >
                {previewLoading ? 'Calculando…' : '👁 Previsualizar escenas'}
              </button>
            </div>
            {previewError && <p className="text-[11px] text-destructive">{previewError}</p>}
            {previewScenes && (
              <div className="space-y-1.5 rounded-lg border border-input p-3">
                <p className="text-[11px] text-muted-foreground">
                  {previewScenes.length} escenas propuestas. Marca cuáles partir en{' '}
                  <b className="text-foreground">micro-escenas</b> (planos cortos por cada ítem de una lista).
                  Solo se ofrece en escenas que enumeran cosas.
                </p>
                {previewScenes.map((s) => (
                  <div
                    key={s.index}
                    className="flex items-start gap-2 rounded-md bg-muted/30 p-2 text-xs"
                  >
                    <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.index + 1}</span>
                    <span className="flex-1">{s.text}</span>
                    {s.isEnumeration ? (
                      <label className="flex shrink-0 items-center gap-1 text-[11px]">
                        <input
                          type="checkbox"
                          checked={microIndices.includes(s.index)}
                          onChange={() => toggleMicro(s.index)}
                          className="h-3.5 w-3.5 accent-[#7c6cff]"
                        />
                        micro
                      </label>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Button type="submit" disabled={submitting} size="lg" className="w-full">
              {submitting ? 'Disparando pipeline...' : '⚡ Generar video (auto)'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={submitting}
              onClick={() => void handleSubmitWithMode('collaborative')}
              className="w-full"
              title="El pipeline pausa entre cada escena. Tú revisas y apruebas escena por escena. Tus comentarios alimentan el VALIDATOR y el cerebro evolutivo."
            >
              {submitting ? '...' : '🤝 Hacer video en conjunto'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function OptionToggle({
  label,
  desc,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        'flex items-center gap-2.5 rounded-lg border p-2.5 transition-colors ' +
        (disabled
          ? 'cursor-not-allowed border-input opacity-40'
          : 'cursor-pointer ' +
            (checked ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/40'))
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#7c6cff]"
      />
      <span className="leading-tight">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{desc}</span>
      </span>
    </label>
  );
}

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function estimateSeconds(text: string): number {
  return Math.round(wordCount(text) / 2.5);
}

// XMLHttpRequest wrapper que devuelve { runId?, error? }. Necesario porque algunas
// extensiones de Chrome inyectan código en window.fetch y lo rompen ("Failed to
// fetch"). XHR es API más vieja y rara vez interceptada por extensiones.
function submitViaXhr(
  url: string,
  body: string,
): Promise<{ runId?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { runId?: string; error?: string };
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          resolve({ error: data.error ?? `HTTP ${xhr.status}` });
        }
      } catch {
        reject(new Error(`Respuesta no-JSON (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Error de red (XHR onerror)'));
    xhr.ontimeout = () => reject(new Error('Timeout de red'));
    xhr.send(body);
  });
}
