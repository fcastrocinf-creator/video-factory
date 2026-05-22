'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AdAnalysis, ScriptProposal } from '@video-factory/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface BrandAsset {
  id: string;
  kind: 'product-shot' | 'packaging' | 'mockup' | 'lifestyle' | 'icon' | 'other';
  description: string;
}
interface BrandOption {
  id: string;
  displayName: string;
  language: string;
  products: Array<{ id: string; name: string }>;
  hasLogo: boolean;
  assets: BrandAsset[];
}

interface RipStatus {
  id: string;
  status: 'uploaded' | 'analyzing' | 'analyzed' | 'failed';
  videoFileName: string;
  videoBytes: number;
  errorMessage: string | null;
  analysis: AdAnalysis | null;
}

export interface RipDetailViewProps {
  ripId: string;
  brands: BrandOption[];
}

type Action = 'idle' | 'rip-confirm' | 'scripts-loading' | 'scripts-list';

export function RipDetailView({ ripId, brands }: RipDetailViewProps) {
  const router = useRouter();
  const [rip, setRip] = useState<RipStatus | null>(null);
  const [pollError, setPollError] = useState('');

  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [productId, setProductId] = useState('');
  // Duración objetivo para los scripts similares. 0 = auto (deja al modelo elegir).
  // Por defecto, cuando llega el análisis, lo seteamos a la duración del original.
  const [targetDurationSec, setTargetDurationSec] = useState(0);
  // Modo de fidelidad para el ripeo: 'fast' (default, ~2-3 min, ~$0.30) o 'high'
  // (per-scene loop hasta 95% similitud con keyframes del original, ~10-15 min, ~$2-3).
  const [fidelityMode, setFidelityMode] = useState<'fast' | 'high'>('fast');
  const [action, setAction] = useState<Action>('idle');
  const [actionError, setActionError] = useState('');
  const [proposals, setProposals] = useState<ScriptProposal[]>([]);

  const selectedBrand = useMemo(
    () => brands.find((b) => b.id === brandId),
    [brands, brandId],
  );
  const productOptions = useMemo(
    () => selectedBrand?.products ?? [],
    [selectedBrand],
  );

  // Poll del status hasta que esté analyzed
  useEffect(() => {
    let stopped = false;
    async function loop() {
      while (!stopped) {
        try {
          const resp = await fetch(`/api/rip/${ripId}`);
          if (resp.ok) {
            const data = (await resp.json()) as RipStatus;
            if (!stopped) {
              setRip(data);
              setPollError('');
              if (data.status === 'analyzed' || data.status === 'failed') return;
            }
          } else if (resp.status === 404) {
            setPollError('Rip no encontrado');
            return;
          }
        } catch (e) {
          setPollError((e as Error).message);
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    void loop();
    return () => {
      stopped = true;
    };
  }, [ripId]);

  useEffect(() => {
    if (productOptions.length > 0 && !productOptions.some((p) => p.id === productId)) {
      setProductId(productOptions[0]!.id);
    } else if (productOptions.length === 0) {
      setProductId('');
    }
  }, [productOptions, productId]);

  // Cuando llega el análisis, seteamos target duration al valor original (única vez).
  useEffect(() => {
    if (rip?.analysis && targetDurationSec === 0) {
      setTargetDurationSec(Math.round(rip.analysis.totalDurationSeconds));
    }
  }, [rip?.analysis, targetDurationSec]);

  /**
   * Construye dinámicamente un preset desde el análisis y devuelve su id.
   * El preset queda persistido en packages/presets/learned-*.preset.json
   * y aparece automáticamente como opción en /create para futuros videos.
   */
  async function buildLearnedPreset(): Promise<string> {
    const resp = await fetch(`/api/rip/${ripId}/build-preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandId }),
    });
    if (!resp.ok) throw new Error(`build-preset ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as { presetId: string };
    return data.presetId;
  }

  async function ripearAnuncio() {
    setAction('rip-confirm');
    setActionError('');
    try {
      // 1. Aprendemos el estilo del original → preset dinámico
      const learnedPresetId = await buildLearnedPreset();
      // 2. Disparamos el ripeo usando ese preset
      const resp = await fetch(`/api/rip/${ripId}/rip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          brandId,
          presetId: learnedPresetId,
          productId: productId || null,
          fidelityMode,
        }),
      });
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as { runId: string };
      router.push(`/runs/${data.runId}`);
    } catch (e) {
      setActionError((e as Error).message);
      setAction('idle');
    }
  }

  async function pedirScripts() {
    setAction('scripts-loading');
    setActionError('');
    try {
      const resp = await fetch(`/api/rip/${ripId}/scripts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          brandId,
          productId: productId || null,
          count: 3,
          // Si > 0, lo enviamos. Si es 0, dejamos al backend usar 40-90s default.
          targetDurationSeconds: targetDurationSec > 0 ? targetDurationSec : undefined,
        }),
      });
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as { proposals: ScriptProposal[] };
      setProposals(data.proposals);
      setAction('scripts-list');
    } catch (e) {
      setActionError((e as Error).message);
      setAction('idle');
    }
  }

  async function refinarScript(proposalId: string, feedback: string) {
    const original = proposals.find((p) => p.id === proposalId);
    if (!original) return;
    setActionError('');
    try {
      const resp = await fetch(`/api/rip/${ripId}/scripts/refine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          originalProposal: original,
          feedback,
          brandId,
          productId: productId || null,
        }),
      });
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as { proposal: ScriptProposal };
      setProposals((prev) => prev.map((p) => (p.id === proposalId ? data.proposal : p)));
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  async function usarScriptEnCreate(proposal: ScriptProposal) {
    setActionError('');
    try {
      // Construimos el preset aprendido antes de redirigir, así /create lo ve
      // disponible en su lista de presets al cargar.
      const learnedPresetId = await buildLearnedPreset();
      sessionStorage.setItem(
        'prefill-script',
        JSON.stringify({
          script: proposal.script,
          brandId,
          presetId: learnedPresetId,
          productId: productId || null,
        }),
      );
      router.push('/create');
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  if (!rip) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Cargando…</p>
        {pollError && <p className="text-sm text-destructive">{pollError}</p>}
      </div>
    );
  }

  if (rip.status === 'analyzing') {
    return (
      <div className="space-y-4">
        <Link href="/rip" className="text-xs text-muted-foreground hover:text-foreground">
          ← Ripear otro
        </Link>
        <Card>
          <CardContent className="pt-6 space-y-2">
            <p className="text-sm font-medium">Analizando el video con Gemini Vision…</p>
            <p className="text-xs text-muted-foreground">
              {rip.videoFileName} · {(rip.videoBytes / 1024 / 1024).toFixed(1)} MB
            </p>
            <p className="text-xs text-muted-foreground">
              Esto tarda 30-90s según la duración del video.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (rip.status === 'failed') {
    return (
      <div className="space-y-4">
        <Link href="/rip" className="text-xs text-muted-foreground hover:text-foreground">
          ← Ripear otro
        </Link>
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="pt-6 space-y-2">
            <p className="text-sm font-medium text-destructive">Análisis falló</p>
            <pre className="text-xs whitespace-pre-wrap text-destructive/80">
              {rip.errorMessage ?? 'Sin detalle'}
            </pre>
          </CardContent>
        </Card>
      </div>
    );
  }

  // status === 'analyzed' — mostramos análisis + acciones
  const a = rip.analysis!;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            href="/rip"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Ripear otro
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Análisis del anuncio</h1>
          <p className="text-sm text-muted-foreground">
            {rip.videoFileName} · {a.totalDurationSeconds.toFixed(0)}s · {a.language}
          </p>
        </div>
      </div>

      {/* ANÁLISIS */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Resumen</p>
            <p className="text-sm">{a.summary}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Línea editorial</p>
            <p className="text-sm">{a.editorialLine}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Hook</p>
              <p className="text-sm">{a.hookType}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Escenas</p>
              <p className="text-sm">{a.scenes.length}</p>
            </div>
          </div>
          {a.product.name && (
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Producto detectado</p>
              <p className="text-sm">
                <strong>{a.product.name}</strong>
                {a.product.visualDescription && ` · ${a.product.visualDescription}`}
              </p>
            </div>
          )}
          {a.cta && (
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">CTA</p>
              <p className="text-sm italic">&ldquo;{a.cta}&rdquo;</p>
            </div>
          )}
          <details className="mt-2">
            <summary className="text-xs cursor-pointer text-muted-foreground hover:text-foreground">
              Ver narración completa + escenas
            </summary>
            <div className="mt-2 space-y-2">
              <div className="rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">
                {a.fullNarration || '(sin narración audible)'}
              </div>
              <ol className="space-y-1 text-xs">
                {a.scenes.map((s) => (
                  <li key={s.index}>
                    <strong>[{s.index}] {s.startSec.toFixed(1)}-{s.endSec.toFixed(1)}s</strong>: {s.visualDescription}
                    {s.narrationFragment && (
                      <span className="block text-muted-foreground italic ml-3">&ldquo;{s.narrationFragment}&rdquo;</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </details>
        </CardContent>
      </Card>

      {/* SELECCIONAR DESTINO */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="text-base font-semibold">¿A qué marca / producto adaptar?</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Marca</label>
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.displayName}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Producto</label>
              <Select value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!selectedBrand}>
                {productOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
          </div>

          {/* Info: estilo automático aprendido del original */}
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <p className="font-medium">🧠 Estilo automático activado</p>
            <p className="text-muted-foreground mt-0.5">
              No elegís un preset. El sistema aprende el estilo del video original
              (paleta, narrador, hook, ritmo de escenas) y lo guarda como una opción
              nueva en <code className="rounded bg-muted px-1">/create</code> para
              reutilizarlo en futuros videos sin volver a analizar.
            </p>
          </div>

          {/* INGREDIENTS GALLERY del producto/marca seleccionados */}
          {selectedBrand && (selectedBrand.hasLogo || selectedBrand.assets.length > 0) && (
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium">
                Ingredients de la marca · se aplican automáticamente al ripeo
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedBrand.hasLogo && (
                  <div className="flex flex-col items-center gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/brands/${selectedBrand.id}/file?which=logo`}
                      alt={`logo ${selectedBrand.displayName}`}
                      className="h-16 w-16 rounded-md border bg-white object-contain p-1"
                    />
                    <span className="text-[10px] text-muted-foreground">logo</span>
                  </div>
                )}
                {selectedBrand.assets.slice(0, 6).map((asset) => (
                  <div key={asset.id} className="flex flex-col items-center gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/brands/${selectedBrand.id}/file?which=asset&assetId=${asset.id}`}
                      alt={asset.description}
                      title={asset.description}
                      className="h-16 w-16 rounded-md border bg-white object-cover"
                    />
                    <span className="text-[10px] text-muted-foreground capitalize">
                      {asset.kind.replace('-', ' ')}
                    </span>
                  </div>
                ))}
                {selectedBrand.assets.length > 6 && (
                  <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted text-[10px] text-muted-foreground">
                    +{selectedBrand.assets.length - 6}
                  </div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Gestionalos en <Link href={`/brands/${selectedBrand.id}`} className="underline hover:text-foreground">Marcas → {selectedBrand.displayName}</Link>.
              </p>
            </div>
          )}
          {selectedBrand && !selectedBrand.hasLogo && selectedBrand.assets.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              La marca no tiene logo ni assets configurados. El ripeo va a generar
              todo desde el análisis del original. Si quieres que reconozca el
              packaging exacto del producto, sube ingredients en{' '}
              <Link href={`/brands/${selectedBrand.id}`} className="underline hover:text-foreground">
                Marcas → {selectedBrand.displayName}
              </Link>.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ACCIONES */}
      <Card>
        <CardContent className="pt-6 space-y-3">
          <p className="text-base font-semibold">¿Qué quieres hacer?</p>

          {/* Toggle Fidelidad: aplica solo a "Ripear anuncio" — el flow de scripts
              similares es solo texto, no genera imágenes contra referencia. */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium">Fidelidad visual del ripeo</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFidelityMode('fast')}
                disabled={action !== 'idle'}
                className={`text-left rounded-md border px-3 py-2 text-xs transition ${
                  fidelityMode === 'fast'
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : 'bg-background hover:bg-muted'
                }`}
              >
                <p className="font-semibold">⚡ Rápido</p>
                <p className="text-muted-foreground text-[11px]">
                  Genera cada escena 1 sola vez. ~2-3 min, ~$0.30. Usa el preset
                  destilado del análisis pero NO compara visualmente con el original.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setFidelityMode('high')}
                disabled={action !== 'idle'}
                className={`text-left rounded-md border px-3 py-2 text-xs transition ${
                  fidelityMode === 'high'
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : 'bg-background hover:bg-muted'
                }`}
              >
                <p className="font-semibold">🎯 Alta fidelidad</p>
                <p className="text-muted-foreground text-[11px]">
                  Por cada escena, loop iterativo: generar → comparar con keyframe
                  del original → refinar prompt → hasta 80% similitud de estilo o
                  3 intentos. Incluye validación anatómica V3. ~6-10 min, ~$2-4.
                </p>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Button
              onClick={ripearAnuncio}
              // Permitir ripear también cuando el user ya vio scripts similares
              // (después de explorar propuestas, quizás quiere ripear el original)
              disabled={action !== 'idle' && action !== 'scripts-list'}
              size="lg"
            >
              {action === 'rip-confirm'
                ? fidelityMode === 'high'
                  ? 'Ripeando en alta fidelidad…'
                  : 'Ripeando…'
                : fidelityMode === 'high'
                  ? '🎯 Ripear (Alta fidelidad)'
                  : '🎬 Ripear anuncio (rápido)'}
            </Button>
            <Button
              variant="outline"
              onClick={pedirScripts}
              disabled={action !== 'idle' && action !== 'scripts-list'}
              size="lg"
            >
              {action === 'scripts-loading' ? 'Generando…' : '✍️ Generar scripts similares'}
            </Button>
          </div>
          {/* Duración objetivo: aplica solo a "scripts similares". Ripear preserva la duración del original. */}
          <div className="flex items-center gap-2 pt-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="dur">
              Duración objetivo (scripts similares):
            </label>
            <input
              id="dur"
              type="number"
              min={10}
              max={120}
              step={5}
              value={targetDurationSec}
              onChange={(e) => setTargetDurationSec(Number(e.target.value) || 0)}
              className="w-20 rounded-md border bg-background px-2 py-1 text-sm"
            />
            <span className="text-xs text-muted-foreground">segundos</span>
            <div className="flex gap-1 ml-2">
              {[15, 30, 45, 60].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setTargetDurationSec(s)}
                  className={`rounded-md border px-2 py-0.5 text-xs ${
                    targetDurationSec === s ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                  }`}
                >
                  {s}s
                </button>
              ))}
            </div>
          </div>
          {actionError && (
            <p className="text-sm text-destructive">{actionError}</p>
          )}
        </CardContent>
      </Card>

      {/* PROPUESTAS */}
      {action === 'scripts-list' && proposals.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Propuestas de guion</h2>
          {proposals.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              onRefine={(fb) => refinarScript(p.id, fb)}
              onUse={() => usarScriptEnCreate(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  onRefine,
  onUse,
}: {
  proposal: ScriptProposal;
  onRefine: (feedback: string) => void;
  onUse: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [showRefine, setShowRefine] = useState(false);
  return (
    <Card>
      <CardContent className="pt-4 space-y-2">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">{proposal.title}</h3>
            <p className="text-xs text-muted-foreground">{proposal.approach}</p>
          </div>
          <span className="text-xs text-muted-foreground">~{proposal.durationSeconds}s</span>
        </div>
        <pre className="whitespace-pre-wrap text-sm rounded-md bg-muted/30 p-3">{proposal.script}</pre>
        <p className="text-[11px] italic text-muted-foreground">
          Fidelidad editorial: {proposal.fidelityNote}
        </p>
        <div className="flex gap-2 flex-wrap pt-2">
          <Button onClick={onUse} size="sm" className="bg-primary text-primary-foreground">
            Usar este script → /create
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowRefine(!showRefine)}>
            {showRefine ? 'Ocultar' : 'Pedir cambios'}
          </Button>
        </div>
        {showRefine && (
          <div className="space-y-2 pt-2">
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Ej: más informal, acorta a 30s, cambia el final por una pregunta, menos agresivo…"
              className="min-h-[60px] text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onRefine(feedback);
                setFeedback('');
                setShowRefine(false);
              }}
              disabled={!feedback.trim()}
            >
              Refinar con este feedback
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
