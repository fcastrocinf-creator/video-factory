// GateFindings — Fase 1 del círculo de mejora ("Mostrar")
//
// Saca los hallazgos del quality gate de la KB a la VISTA: muestra el veredicto
// (pass/revisar/fail) + los bloqueantes y recomendaciones que Gemini detectó sobre
// el render, leídos de /api/runs/[id]/gate. Antes esto quedaba enterrado en
// storage/kb; ahora el operador VE qué está mal sin abrir el filesystem.
//
// Mismo patrón que ValidationLog: fetch único, silencioso si no hay reporte
// (run viejo o sin VF_GATE_ON_RENDER), tipos definidos inline (componente cliente).

'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';

type Severidad = 'low' | 'medium' | 'high' | 'critical';

interface GateBlocker {
  dimension: string;
  severidad: Severidad;
  estado: string;
  titulo: string;
  fixPropuesto: string;
  confianza: number;
}

interface QualityGateReport {
  veredicto: 'pass' | 'revisar' | 'fail';
  resumen: string;
  comparedWithOriginal: boolean;
  bloqueantes: GateBlocker[];
  recomendaciones: GateBlocker[];
  especialistasAuditados: string[];
  errores: string[];
}

type RepairActionKind =
  | 'regenerate-image'
  | 'reanimate'
  | 'extend-duration'
  | 'trim-duration'
  | 'regenerate-scene'
  | 'surface-to-editor'
  | 'escalate';

interface RepairTarget {
  target: string;
  sceneIndex: number | null;
  action: { kind: RepairActionKind };
}

interface GateResponse {
  qualityGate: QualityGateReport | null;
  repairs: RepairTarget[];
}

// Cómo se lee cada acción de reparación (Fase 2 — siempre requiere tu OK).
const ACTION_LABEL: Record<RepairActionKind, string> = {
  'surface-to-editor': '✏️ Ajustar en el editor',
  escalate: '🔧 Revisión / regeneración mayor',
  'regenerate-image': '🔄 Regenerar imagen',
  reanimate: '🎞️ Re-animar la escena',
  'regenerate-scene': '🔄 Regenerar la escena',
  'extend-duration': '⏱️ Extender duración',
  'trim-duration': '⏱️ Recortar duración',
};

interface GateFindingsProps {
  runId: string;
}

function SeverityChip({ severidad }: { severidad: Severidad }) {
  const styles: Record<Severidad, string> = {
    low: 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/40',
    medium: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/40',
    high: 'bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-500/40',
    critical: 'bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40',
  };
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${styles[severidad]}`}
    >
      {severidad}
    </span>
  );
}

const VERDICTO_STYLE: Record<string, string> = {
  pass: 'bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/40',
  revisar: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/40',
  fail: 'bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40',
};

function FindingCard({ f, action }: { f: GateBlocker; action?: { kind: RepairActionKind } }) {
  return (
    <div className="space-y-1 rounded border border-border/50 bg-background p-2">
      <div className="flex items-center gap-2">
        <SeverityChip severidad={f.severidad} />
        <span className="text-xs font-medium text-muted-foreground">{f.dimension}</span>
      </div>
      <p className="text-xs font-medium">{f.titulo}</p>
      <p className="text-xs text-muted-foreground">💡 {f.fixPropuesto}</p>
      {action && (
        <div className="flex items-center gap-2 pt-1">
          <span className="rounded border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium">
            {ACTION_LABEL[action.kind]}
          </span>
          <span className="text-xs text-muted-foreground">— con tu OK</span>
        </div>
      )}
    </div>
  );
}

export function GateFindings({ runId }: GateFindingsProps) {
  const [data, setData] = useState<GateResponse | null>(null);
  const [error, setError] = useState('');
  const [recsOpen, setRecsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runId}/gate`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return r.json() as Promise<GateResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de red');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Silencioso si aún cargando o no hay reporte — no metemos ruido visual.
  if (error) {
    return (
      <p className="text-xs text-muted-foreground">
        No se pudieron cargar los hallazgos del gate: {error}
      </p>
    );
  }
  if (!data || !data.qualityGate) return null;

  const gate = data.qualityGate;
  const verdictoStyle = VERDICTO_STYLE[gate.veredicto] ?? VERDICTO_STYLE['revisar'];

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">🚪 Compuerta de calidad</h3>
            <p className="text-xs text-muted-foreground">
              Lo que Gemini vio y oyó en el render
              {gate.comparedWithOriginal ? ', comparado con el original' : ''}.
            </p>
          </div>
          <span
            className={`shrink-0 rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${verdictoStyle}`}
          >
            {gate.veredicto}
          </span>
        </div>

        <p className="rounded border border-border bg-muted/30 px-3 py-2 text-xs italic text-muted-foreground">
          {gate.resumen}
        </p>

        {gate.bloqueantes.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-red-600">
              Bloqueantes ({gate.bloqueantes.length})
            </h4>
            {gate.bloqueantes.map((f, i) => (
              <FindingCard key={i} f={f} action={data.repairs?.[i]?.action} />
            ))}
          </div>
        )}

        {gate.recomendaciones.length > 0 && (
          <div className="rounded border border-border bg-muted/30">
            <button
              type="button"
              onClick={() => setRecsOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-muted/50"
            >
              <span>Recomendaciones ({gate.recomendaciones.length})</span>
              <span className="text-muted-foreground">{recsOpen ? '▾' : '▸'}</span>
            </button>
            {recsOpen && (
              <div className="space-y-2 px-3 pb-3">
                {gate.recomendaciones.map((f, i) => (
                  <FindingCard key={i} f={f} />
                ))}
              </div>
            )}
          </div>
        )}

        {gate.errores.length > 0 && (
          <p className="text-xs text-red-600">
            ⚠ El juez no pudo evaluar todo: {gate.errores.join('; ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
