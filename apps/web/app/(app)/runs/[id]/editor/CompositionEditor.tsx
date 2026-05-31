'use client';

// EDITOR MANUAL DE COMPOSICIÓN (Fase 3).
//
// Canvas 9:16 donde el usuario ve las piezas (CompositeElement) de una escena y
// puede moverlas, redimensionarlas, rotarlas, reordenarlas por capa y ajustar
// su timing. Persiste vía PUT /api/runs/[id]/composition.
//
// Cada ajuste manual marca el elemento con manuallyAdjusted=true — el loop de
// aprendizaje (Fase 4) usa ese flag para registrar la corrección IA→humano.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ClaudeChatPanel } from '@/components/ClaudeChatPanel';

interface Rect {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
}
interface CompositeElement {
  id: string;
  kind: 'image' | 'video' | 'text';
  imagePath?: string;
  videoPath?: string;
  text?: string;
  rect: Rect;
  rotationDeg?: number;
  opacity?: number;
  zIndex?: number;
  fit?: 'cover' | 'contain' | 'fill';
  cornerRadiusPct?: number;
  startSeconds?: number;
  endSeconds?: number;
  manuallyAdjusted?: boolean;
}
interface EditorScene {
  index: number;
  text: string;
  imagePath?: string;
  compositeLayout?: string;
  composition?: CompositeElement[];
}

const CANVAS_H = 620; // px — altura fija del canvas
const CANVAS_W = (CANVAS_H * 9) / 16; // 9:16

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';
interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  startRect: Rect;
}

function baseName(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function CompositionEditor({ runId }: { runId: string }) {
  const [scenes, setScenes] = useState<EditorScene[]>([]);
  const [selectedSceneIdx, setSelectedSceneIdx] = useState<number | null>(null);
  const [elements, setElements] = useState<CompositeElement[]>([]);
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  // Ken Burns OPT-IN: movimiento (pan/zoom) sobre las imágenes. Default OFF —
  // las escenas quedan fijas salvo que el usuario lo active acá.
  const [kenBurns, setKenBurns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // --- Carga inicial del sceneTrack ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(`/api/runs/${runId}/composition`);
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { scenes: EditorScene[] };
        if (cancelled) return;
        setScenes(data.scenes);
        // Seleccionar la primera escena con composición, o la primera a secas.
        const firstFreeform = data.scenes.find(
          (s) => s.composition && s.composition.length > 0,
        );
        const first = firstFreeform ?? data.scenes[0];
        if (first) {
          setSelectedSceneIdx(first.index);
          setElements(first.composition ? structuredClone(first.composition) : []);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const selectedScene = useMemo(
    () => scenes.find((s) => s.index === selectedSceneIdx) ?? null,
    [scenes, selectedSceneIdx],
  );
  const selectedEl = useMemo(
    () => elements.find((e) => e.id === selectedElId) ?? null,
    [elements, selectedElId],
  );

  // --- Cambiar de escena ---
  const selectScene = useCallback(
    (idx: number) => {
      if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartar?')) return;
      const sc = scenes.find((s) => s.index === idx);
      setSelectedSceneIdx(idx);
      setElements(sc?.composition ? structuredClone(sc.composition) : []);
      setSelectedElId(null);
      setDirty(false);
      setNotice(null);
    },
    [scenes, dirty],
  );

  // --- Mutar un elemento ---
  const patchElement = useCallback((id: string, patch: Partial<CompositeElement>) => {
    setElements((prev) =>
      prev.map((el) =>
        el.id === id ? { ...el, ...patch, manuallyAdjusted: true } : el,
      ),
    );
    setDirty(true);
  }, []);

  const patchRect = useCallback(
    (id: string, patch: Partial<Rect>) => {
      setElements((prev) =>
        prev.map((el) =>
          el.id === id
            ? { ...el, rect: { ...el.rect, ...patch }, manuallyAdjusted: true }
            : el,
        ),
      );
      setDirty(true);
    },
    [],
  );

  // --- Drag / resize ---
  const onPointerDown = useCallback(
    (e: React.MouseEvent, id: string, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedElId(id);
      const el = elements.find((x) => x.id === id);
      if (!el) return;
      dragRef.current = {
        id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        startRect: { ...el.rect },
      };

      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const dxPct = ((ev.clientX - d.startX) / CANVAS_W) * 100;
        const dyPct = ((ev.clientY - d.startY) / CANVAS_H) * 100;
        const r = { ...d.startRect };
        if (d.mode === 'move') {
          r.xPct = clamp(d.startRect.xPct + dxPct, -20, 100);
          r.yPct = clamp(d.startRect.yPct + dyPct, -20, 100);
        } else {
          // Resize por esquina. minSize 5%.
          if (d.mode === 'se') {
            r.widthPct = Math.max(5, d.startRect.widthPct + dxPct);
            r.heightPct = Math.max(5, d.startRect.heightPct + dyPct);
          } else if (d.mode === 'nw') {
            r.widthPct = Math.max(5, d.startRect.widthPct - dxPct);
            r.heightPct = Math.max(5, d.startRect.heightPct - dyPct);
            r.xPct = d.startRect.xPct + (d.startRect.widthPct - r.widthPct);
            r.yPct = d.startRect.yPct + (d.startRect.heightPct - r.heightPct);
          } else if (d.mode === 'ne') {
            r.widthPct = Math.max(5, d.startRect.widthPct + dxPct);
            r.heightPct = Math.max(5, d.startRect.heightPct - dyPct);
            r.yPct = d.startRect.yPct + (d.startRect.heightPct - r.heightPct);
          } else if (d.mode === 'sw') {
            r.widthPct = Math.max(5, d.startRect.widthPct - dxPct);
            r.heightPct = Math.max(5, d.startRect.heightPct + dyPct);
            r.xPct = d.startRect.xPct + (d.startRect.widthPct - r.widthPct);
          }
        }
        setElements((prev) =>
          prev.map((x) => (x.id === d.id ? { ...x, rect: r, manuallyAdjusted: true } : x)),
        );
      };
      const onUp = () => {
        dragRef.current = null;
        setDirty(true);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [elements],
  );

  // --- Capas ---
  const moveLayer = useCallback(
    (id: string, dir: 1 | -1) => {
      setElements((prev) => {
        const sorted = [...prev].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
        const i = sorted.findIndex((e) => e.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= sorted.length) return prev;
        // Intercambiar zIndex con el vecino.
        const a = sorted[i]!;
        const b = sorted[j]!;
        const az = a.zIndex ?? 0;
        const bz = b.zIndex ?? 0;
        return prev.map((e) => {
          if (e.id === a.id) return { ...e, zIndex: bz };
          if (e.id === b.id) return { ...e, zIndex: az };
          return e;
        });
      });
      setDirty(true);
    },
    [],
  );

  const removeElement = useCallback((id: string) => {
    setElements((prev) => prev.filter((e) => e.id !== id));
    setSelectedElId(null);
    setDirty(true);
  }, []);

  // Crear composición inicial a partir de la imagen de escena (1 elemento
  // full-frame). Permite empezar a editar escenas que aún no son freeform.
  const initComposition = useCallback(() => {
    if (!selectedScene) return;
    const src = selectedScene.imagePath;
    const el: CompositeElement = {
      id: `s${selectedScene.index}_base`,
      kind: 'image',
      imagePath: src,
      rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 },
      rotationDeg: 0,
      opacity: 1,
      zIndex: 0,
      fit: 'cover',
      cornerRadiusPct: 0,
      manuallyAdjusted: true,
    };
    setElements([el]);
    setSelectedElId(el.id);
    setDirty(true);
  }, [selectedScene]);

  // Duplicar el elemento seleccionado (útil para construir collages).
  const duplicateSelected = useCallback(() => {
    if (!selectedEl) return;
    const copy: CompositeElement = {
      ...structuredClone(selectedEl),
      id: `${selectedEl.id}_copy${Date.now() % 10000}`,
      rect: {
        ...selectedEl.rect,
        xPct: clamp(selectedEl.rect.xPct + 5, 0, 90),
        yPct: clamp(selectedEl.rect.yPct + 5, 0, 90),
      },
      zIndex: (selectedEl.zIndex ?? 0) + 1,
      manuallyAdjusted: true,
    };
    setElements((prev) => [...prev, copy]);
    setSelectedElId(copy.id);
    setDirty(true);
  }, [selectedEl]);

  // --- Guardar ---
  const save = useCallback(async () => {
    if (selectedSceneIdx === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await fetch(`/api/runs/${runId}/composition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneIndex: selectedSceneIdx, composition: elements }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      // Reflejar el guardado en el estado local de escenas.
      setScenes((prev) =>
        prev.map((s) =>
          s.index === selectedSceneIdx ? { ...s, composition: structuredClone(elements) } : s,
        ),
      );
      setDirty(false);
      setNotice('Composición guardada. Re-renderiza para ver el resultado en el video.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [runId, selectedSceneIdx, elements]);

  // --- Re-renderizar el video con la composición editada ---
  const rerender = useCallback(async () => {
    if (dirty) {
      setError('Guarda los cambios antes de re-renderizar.');
      return;
    }
    setRerendering(true);
    setError(null);
    try {
      const resp = await fetch(`/api/runs/${runId}/rerender`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kenBurns }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      // Redirigir a la página del run para ver el progreso del render.
      window.location.href = `/runs/${runId}`;
    } catch (e) {
      setError((e as Error).message);
      setRerendering(false);
    }
  }, [runId, dirty, kenBurns]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Cargando composición…</p>;
  }
  if (error && scenes.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <p className="text-sm text-red-500">{error}</p>
          <Link href={`/runs/${runId}`} className="text-sm underline">
            ← Volver al run
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex gap-4">
      {/* Columna izquierda: lista de escenas */}
      <div className="w-44 shrink-0 space-y-1">
        <p className="text-xs font-semibold text-muted-foreground mb-1">ESCENAS</p>
        {scenes.map((s) => {
          const isFreeform = (s.composition?.length ?? 0) > 0;
          return (
            <button
              key={s.index}
              onClick={() => selectScene(s.index)}
              className={`w-full text-left rounded px-2 py-1.5 text-xs transition ${
                s.index === selectedSceneIdx
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/70'
              }`}
            >
              <span className="font-mono">#{String(s.index).padStart(2, '0')}</span>{' '}
              {isFreeform ? `· ${s.composition!.length} piezas` : '· single'}
            </button>
          );
        })}
      </div>

      {/* Centro: canvas */}
      <div className="shrink-0">
        <div
          ref={canvasRef}
          onMouseDown={() => setSelectedElId(null)}
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            position: 'relative',
            background: '#0a0a0a',
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid #333',
            userSelect: 'none',
          }}
        >
          {elements.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
              <p className="text-xs text-muted-foreground text-center">
                Esta escena no tiene composición libre todavía.
              </p>
              <Button size="sm" onClick={initComposition}>
                Crear composición
              </Button>
            </div>
          )}
          {[...elements]
            .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
            .map((el) => {
              const file = baseName(el.imagePath ?? el.videoPath);
              const selected = el.id === selectedElId;
              return (
                <div
                  key={el.id}
                  onMouseDown={(e) => onPointerDown(e, el.id, 'move')}
                  style={{
                    position: 'absolute',
                    left: `${el.rect.xPct}%`,
                    top: `${el.rect.yPct}%`,
                    width: `${el.rect.widthPct}%`,
                    height: `${el.rect.heightPct}%`,
                    transform: `rotate(${el.rotationDeg ?? 0}deg)`,
                    opacity: el.opacity ?? 1,
                    borderRadius: el.cornerRadiusPct ? `${el.cornerRadiusPct}%` : 0,
                    outline: selected ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,0.25)',
                    cursor: 'move',
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                  }}
                >
                  {el.kind === 'text' ? (
                    <div className="w-full h-full flex items-center justify-center bg-black/60 text-white text-xs p-1 text-center">
                      {el.text ?? '(texto)'}
                    </div>
                  ) : file ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/runs/${runId}/scene-asset?file=${encodeURIComponent(file)}`}
                      alt={el.id}
                      draggable={false}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: el.fit ?? 'cover',
                        pointerEvents: 'none',
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-neutral-800 text-[10px] text-neutral-400">
                      sin imagen
                    </div>
                  )}
                  {/* Handles de resize en las 4 esquinas */}
                  {selected &&
                    (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                      <div
                        key={corner}
                        onMouseDown={(e) => onPointerDown(e, el.id, corner)}
                        style={{
                          position: 'absolute',
                          width: 12,
                          height: 12,
                          background: '#3b82f6',
                          border: '2px solid #fff',
                          borderRadius: 2,
                          ...(corner.includes('n') ? { top: -6 } : { bottom: -6 }),
                          ...(corner.includes('w') ? { left: -6 } : { right: -6 }),
                          cursor: `${corner}-resize`,
                        }}
                      />
                    ))}
                </div>
              );
            })}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Canvas 9:16 — arrastra para mover, esquinas para redimensionar
        </p>
      </div>

      {/* Columna derecha: propiedades + capas + acciones */}
      <div className="flex-1 min-w-[260px] space-y-4">
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground">
                {dirty ? '● Cambios sin guardar' : 'Sin cambios'}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={duplicateSelected} disabled={!selectedEl}>
                  Duplicar
                </Button>
                <Button size="sm" onClick={save} disabled={saving || !dirty}>
                  {saving ? 'Guardando…' : 'Guardar'}
                </Button>
                <label
                  className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer select-none"
                  title="Aplica movimiento Ken Burns (pan/zoom) a las imágenes estáticas. Por defecto las escenas quedan fijas."
                >
                  <input
                    type="checkbox"
                    checked={kenBurns}
                    onChange={(e) => setKenBurns(e.target.checked)}
                    className="h-3 w-3"
                  />
                  Movimiento Ken Burns
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={rerender}
                  disabled={rerendering || dirty}
                  title={dirty ? 'Guarda los cambios primero' : 'Re-renderiza el video con la composición'}
                >
                  {rerendering ? 'Encolando…' : 'Re-renderizar'}
                </Button>
              </div>
            </div>
            {notice && <p className="text-[11px] text-green-500">{notice}</p>}
            {error && <p className="text-[11px] text-red-500">{error}</p>}
          </CardContent>
        </Card>

        {/* Propiedades del elemento seleccionado */}
        {selectedEl && (
          <Card>
            <CardContent className="p-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">
                PIEZA · <span className="font-mono">{selectedEl.id}</span>
              </p>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="X %"
                  value={selectedEl.rect.xPct}
                  onChange={(v) => patchRect(selectedEl.id, { xPct: v })}
                />
                <NumberField
                  label="Y %"
                  value={selectedEl.rect.yPct}
                  onChange={(v) => patchRect(selectedEl.id, { yPct: v })}
                />
                <NumberField
                  label="Ancho %"
                  value={selectedEl.rect.widthPct}
                  onChange={(v) => patchRect(selectedEl.id, { widthPct: Math.max(5, v) })}
                />
                <NumberField
                  label="Alto %"
                  value={selectedEl.rect.heightPct}
                  onChange={(v) => patchRect(selectedEl.id, { heightPct: Math.max(5, v) })}
                />
                <NumberField
                  label="Rotación °"
                  value={selectedEl.rotationDeg ?? 0}
                  onChange={(v) => patchElement(selectedEl.id, { rotationDeg: v })}
                />
                <NumberField
                  label="Opacidad"
                  value={selectedEl.opacity ?? 1}
                  step={0.05}
                  onChange={(v) => patchElement(selectedEl.id, { opacity: clamp(v, 0, 1) })}
                />
                <NumberField
                  label="Capa (z)"
                  value={selectedEl.zIndex ?? 0}
                  onChange={(v) => patchElement(selectedEl.id, { zIndex: Math.round(v) })}
                />
                <NumberField
                  label="Borde %"
                  value={selectedEl.cornerRadiusPct ?? 0}
                  onChange={(v) =>
                    patchElement(selectedEl.id, { cornerRadiusPct: clamp(v, 0, 50) })
                  }
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-red-500"
                onClick={() => removeElement(selectedEl.id)}
              >
                Eliminar pieza
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Lista de capas */}
        {elements.length > 0 && (
          <Card>
            <CardContent className="p-3 space-y-1">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                CAPAS (arriba = al frente)
              </p>
              {[...elements]
                .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))
                .map((el) => (
                  <div
                    key={el.id}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] ${
                      el.id === selectedElId ? 'bg-primary/15' : 'hover:bg-muted'
                    }`}
                  >
                    <button
                      className="flex-1 text-left font-mono truncate"
                      onClick={() => setSelectedElId(el.id)}
                    >
                      {el.id}
                      {el.manuallyAdjusted && <span className="text-amber-500"> ·editado</span>}
                    </button>
                    <button
                      className="px-1 text-muted-foreground hover:text-foreground"
                      onClick={() => moveLayer(el.id, 1)}
                      title="Subir capa"
                    >
                      ▲
                    </button>
                    <button
                      className="px-1 text-muted-foreground hover:text-foreground"
                      onClick={() => moveLayer(el.id, -1)}
                      title="Bajar capa"
                    >
                      ▼
                    </button>
                  </div>
                ))}
            </CardContent>
          </Card>
        )}

        <Link href={`/runs/${runId}`} className="block text-xs underline text-muted-foreground">
          ← Volver al run
        </Link>

        {/* M8: chat IA para discutir cambios en escenas del editor */}
        <div className="pt-3">
          <ClaudeChatPanel
            contextType="scene-edit"
            contextData={{
              runId,
              selectedSceneIdx,
              selectedElementId: selectedElId,
              totalScenes: scenes.length,
              currentScene:
                selectedSceneIdx !== null && scenes[selectedSceneIdx]
                  ? {
                      idx: selectedSceneIdx,
                      text: scenes[selectedSceneIdx]?.text?.slice(0, 200),
                      elementsCount:
                        scenes[selectedSceneIdx]?.composition?.length ?? 0,
                    }
                  : null,
              dirty,
            }}
            title="Discutí cambios con Claude"
            placeholder="Ej: '¿Cómo cambio el prompt de scene 5 para que el producto se vea?' o 'El layout actual sobrecarga la imagen?'"
          />
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-full rounded border border-input bg-background px-1.5 py-1 text-xs"
      />
    </label>
  );
}
