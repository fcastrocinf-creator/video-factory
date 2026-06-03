// quality-gate.ts — COMPUERTA DE CALIDAD video+audio (sobre el render producido).
//
// El "norte" del owner: que los validators corran sobre lo CREADO (no solo al
// aprender) y emitan un VEREDICTO claro pass/revisar/fail + recomendaciones que
// el owner pueda aplicar. Esta compuerta NO reconstruye nada: envuelve el panel
// multi-agente con visión que YA existe (runFormatAudit) y deriva el veredicto de
// forma DETERMINISTA (sin IA) a partir de los hallazgos verificados.
//
// Diseño (100% aditivo, reversible):
//   1. runQualityGate: resuelve la ruta del render → (opcional) deriva contexto/
//      rúbrica → corre runFormatAudit → decideGateVerdict → persiste el veredicto.
//   2. decideGateVerdict: FUNCIÓN PURA (sin IA, testeable) que vuelca los hallazgos
//      a pass/revisar/fail según la GatePolicy.
//   3. deriveRubric: contexto DETERMINISTA (hermano de planTimelineFromFormat) que
//      afina los briefs del panel con los criterios del formato aprendido.
//   4. RepairLoop: interfaz tipada (FASE 2, no implementada) para la reparación
//      dirigida de artefactos del run.
//
// Invariantes respetados: NADA se auto-aplica (solo PROPONE); storage vía paths.ts
// (nunca process.cwd()); NO agrega emisores paralelos a la KB (lo hace el panel);
// español neutro en toda salida. Inyección de `deps` para testear SIN IA/ffmpeg.

import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { RUNS_DIR } from '../paths';
import type { AdAnalysis } from '@video-factory/contracts';
import { planTimelineFromFormat, type FormatTimelinePlan } from '../format-to-timeline';
import {
  runFormatAudit,
  formatAuditEnabled,
  type FormatAuditResult,
  type FormatAuditDeps,
} from './format-audit';
import {
  writeQualityGateReport,
  type Hallazgo,
  type HallazgoSeveridad,
  type HallazgoEstado,
  type GateVeredicto,
  type GateBlocker,
  type GatePolicyRecord,
  type QualityGateReport,
} from './findings';

export type { GateVeredicto, GateBlocker, QualityGateReport } from './findings';

// ─── Política de la compuerta (determinista, sin IA) ──────────────────────────

export interface GatePolicy {
  /** Severidad mínima (en estado contable) que vuelca el veredicto a 'fail'. Default 'critical'. */
  failOn: 'high' | 'critical';
  /** Severidad mínima que vuelca a 'revisar' (si no hay 'fail'). Default 'high'. */
  reviewOn: 'medium' | 'high';
  /** Nº de 'medium' contables que también disparan 'revisar'. Default 3. */
  reviewOnMediumCount: number;
  /** Si true, los hallazgos 'abierto' (no verificados) cuentan igual que 'confirmado'.
   *  Default true para fail-safe (no dejar pasar un critical solo por no verificarse). */
  countUnverified: boolean;
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  failOn: 'critical',
  reviewOn: 'high',
  reviewOnMediumCount: 3,
  countUnverified: true,
};

const SEVERITY_RANK: Record<HallazgoSeveridad, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Lee la política desde el entorno (VF_GATE_*). next.config.mjs carga el .env raíz. */
export function gatePolicyFromEnv(): Partial<GatePolicy> {
  const out: Partial<GatePolicy> = {};
  const failOn = process.env['VF_GATE_FAIL_ON'];
  if (failOn === 'high' || failOn === 'critical') out.failOn = failOn;
  const reviewOn = process.env['VF_GATE_REVIEW_ON'];
  if (reviewOn === 'medium' || reviewOn === 'high') out.reviewOn = reviewOn;
  const medCount = process.env['VF_GATE_REVIEW_ON_MEDIUM_COUNT'];
  if (medCount !== undefined && medCount !== '') {
    const n = Number.parseInt(medCount, 10);
    if (Number.isFinite(n) && n > 0) out.reviewOnMediumCount = n;
  }
  const countUnverified = process.env['VF_GATE_COUNT_UNVERIFIED'];
  if (countUnverified === '0' || countUnverified === 'false') out.countUnverified = false;
  if (countUnverified === '1' || countUnverified === 'true') out.countUnverified = true;
  return out;
}

function resolvePolicy(override?: Partial<GatePolicy>): GatePolicy {
  return { ...DEFAULT_GATE_POLICY, ...gatePolicyFromEnv(), ...(override ?? {}) };
}

// ─── La Rúbrica: contexto determinista que afina el panel (Lente B) ────────────
// NO es un motor de juicio paralelo: es texto que se inyecta al contextText de
// runFormatAudit para que cada especialista verifique CRITERIOS del formato en vez
// de buscar defectos genéricos. Las dimensiones están alineadas 1:1 con
// FORMAT_SPECIALISTS (+ 'global').

export type RubricDimension =
  | 'composicion-recorte'
  | 'animacion-movimiento'
  | 'voces-diarizacion'
  | 'producto-legibilidad'
  | 'captions-anotacion'
  | 'fidelidad'
  | 'global';

export interface RubricCriterion {
  /** Id estable, ej 'voces.n-hablantes', 'anim.experto-habla-a-camara'. */
  id: string;
  dimension: RubricDimension;
  /** Frase OBJETIVA del estado CORRECTO (no del defecto), en español neutro. */
  criterion: string;
  /** Cuánto rompe el formato si falla (1 leve … 5 crítico). */
  weight: 1 | 2 | 3 | 4 | 5;
  failSeverity: HallazgoSeveridad;
  target?: { metric: string; value: number; tolerance: number; unit?: string };
  /** Trazabilidad: de dónde se derivó ('product', 'scenes[3]', 'hookType'…). */
  derivedFrom: string;
  confidence: 'firme' | 'inferido';
}

export interface Rubric {
  formatLabel: string;
  criteria: RubricCriterion[];
  byDimension: Record<RubricDimension, RubricCriterion[]>;
  /** De plan.componentsToGenerate — su ausencia en el render = fallo. */
  requiredComponents: string[];
  acceptanceSummary: string;
}

const ALL_DIMENSIONS: RubricDimension[] = [
  'composicion-recorte',
  'animacion-movimiento',
  'voces-diarizacion',
  'producto-legibilidad',
  'captions-anotacion',
  'fidelidad',
  'global',
];

function emptyByDimension(): Record<RubricDimension, RubricCriterion[]> {
  const acc = {} as Record<RubricDimension, RubricCriterion[]>;
  for (const d of ALL_DIMENSIONS) acc[d] = [];
  return acc;
}

/** ¿El formato es de tipo antes/después? (heurística sobre texto del análisis). */
function isBeforeAfterFormat(analysis: AdAnalysis): boolean {
  const hay = `${analysis.editorialLine} ${analysis.summary} ${(
    analysis.visualStyleProfile?.aestheticTags ?? []
  ).join(' ')}`.toLowerCase();
  return /antes\s*[/y-]?\s*despu[eé]s|before\s*[-/]?\s*after|hinchad|inflamad|progres/i.test(hay);
}

/**
 * Deriva la RÚBRICA del formato aprendido. DETERMINISTA (sin IA), hermano de
 * planTimelineFromFormat. `motion` es opcional: con él se emiten criterios de
 * ritmo/animado-pct; sin él se omiten.
 *
 * Anti-falsos-positivos (invariante): nunca deriva un criterio cuyo soporte sea
 * null (sin producto → sin criterio de producto; textOverlayStyle null → sin
 * criterio de subtítulos).
 */
export function deriveRubric(
  analysis: AdAnalysis,
  plan: FormatTimelinePlan,
  motion?: { cuts: number[]; animatedPct: number },
): Rubric {
  const criteria: RubricCriterion[] = [];

  // ── voces-diarizacion: nº de roles/hablantes del formato ─────────────────────
  const voiceComponents = plan.componentsToGenerate.filter((c) => /^voz:/i.test(c));
  const nVoces = voiceComponents.length;
  if (nVoces >= 2) {
    criteria.push({
      id: 'voces.n-hablantes',
      dimension: 'voces-diarizacion',
      criterion: `El render conserva ${nVoces} voces DISTINTAS (${voiceComponents
        .map((v) => v.replace(/^voz:\s*/i, ''))
        .join(' + ')}); NO colapsa todo a una sola voz.`,
      weight: 5,
      failSeverity: 'high',
      target: { metric: 'hablantes-distintos', value: nVoces, tolerance: 0 },
      derivedFrom: 'plan.componentsToGenerate (voz:*)',
      confidence: 'firme',
    });
  }

  // ── animacion-movimiento: experto a cámara (UGC real, no foto fija) ──────────
  const hasAuthority = plan.segments.some((s) => s.role === 'authority-fullscreen');
  if (hasAuthority) {
    criteria.push({
      id: 'anim.experto-habla-a-camara',
      dimension: 'animacion-movimiento',
      criterion:
        'El experto habla a cámara en una escena REAL tipo UGC (video real), NO es una foto fija animada sobre fondo verde ni un retrato que "solo se mueve".',
      weight: 5,
      failSeverity: 'critical',
      derivedFrom: 'plan.segments[role=authority-fullscreen]',
      confidence: 'firme',
    });
    criteria.push({
      id: 'anim.lipsync-voz-nativa',
      dimension: 'animacion-movimiento',
      criterion:
        'El lipsync usa la voz NATIVA del clip (audio y labios sincronizados de origen), en escenas cortas; los labios coinciden con lo que se oye.',
      weight: 4,
      failSeverity: 'high',
      derivedFrom: 'plan.segments[role=authority-fullscreen] (lipsync)',
      confidence: 'inferido',
    });
  }

  // Ritmo de cortes / mezcla animado-estático: SOLO si hay mapa de movimiento.
  if (motion) {
    if (Number.isFinite(motion.animatedPct)) {
      criteria.push({
        id: 'anim.mezcla-animado-estatico',
        dimension: 'animacion-movimiento',
        criterion: `El render reproduce la mezcla animado/estático del original (~${Math.round(
          motion.animatedPct,
        )}% animado): NO deja como foto fija un tramo que el original anima, ni anima un tramo que debía ser estático.`,
        weight: 3,
        failSeverity: 'medium',
        target: { metric: 'animado', value: Math.round(motion.animatedPct), tolerance: 20, unit: '%' },
        derivedFrom: 'motion.animatedPct',
        confidence: 'inferido',
      });
    }
    if (motion.cuts.length >= 2) {
      criteria.push({
        id: 'anim.densidad-cortes',
        dimension: 'animacion-movimiento',
        criterion: `El pulso vertical mantiene una densidad de cortes parecida al original (~${motion.cuts.length} cortes): sin tramos muertos ni escenas que se estiran.`,
        weight: 2,
        failSeverity: 'low',
        target: { metric: 'cortes', value: motion.cuts.length, tolerance: 3 },
        derivedFrom: 'motion.cuts',
        confidence: 'inferido',
      });
    }
  }

  // ── composicion-recorte: PiP / recortes limpios ──────────────────────────────
  const hasPip = plan.segments.some((s) => s.role === 'user-testimonial-pip') ||
    plan.componentsToGenerate.some((c) => /pip|recort/i.test(c));
  if (hasPip) {
    criteria.push({
      id: 'recorte.bordes-limpios',
      dimension: 'composicion-recorte',
      criterion:
        'Las figuras recortadas/PiP tienen bordes limpios: sin halo ni fleco verde, sin translucidez ni aspecto "pegado"/estampado; escala y posición naturales.',
      weight: 4,
      failSeverity: 'high',
      derivedFrom: 'plan.segments[role=user-testimonial-pip]',
      confidence: 'firme',
    });
  }

  // ── producto-legibilidad: SOLO si hay producto con soporte ───────────────────
  const hasProduct = !!analysis.product && (!!analysis.product.name || !!analysis.product.visualDescription);
  if (hasProduct) {
    criteria.push({
      id: 'producto.visible-legible',
      dimension: 'producto-legibilidad',
      criterion:
        'El producto aparece bien integrado (luz/escala/sombra) y su etiqueta/marca/claim se LEE en pantalla de móvil; no está ausente, diminuto ni con texto ilegible.',
      weight: 3,
      failSeverity: 'medium',
      derivedFrom: 'analysis.product',
      confidence: 'firme',
    });
  }

  // ── captions-anotacion: anotaciones ancladas + sincronizadas ─────────────────
  const hasAnnotation = plan.segments.some((s) => s.annotation !== null);
  if (hasAnnotation) {
    const zonas = [...new Set(
      plan.segments.filter((s) => s.annotation).map((s) => s.annotation!.zone),
    )];
    criteria.push({
      id: 'anotacion.anclada-sincronizada',
      dimension: 'captions-anotacion',
      criterion: `Cada anotación (círculo/flecha) se ancla a la ZONA exacta (${zonas.join(
        ', ',
      )}) y aparece SINCRONIZADA al momento en que la narración menciona ese rasgo; no cae en vacío ni va desfasada.`,
      weight: 4,
      failSeverity: 'high',
      derivedFrom: 'plan.segments[].annotation',
      confidence: 'firme',
    });
  }
  // Subtítulos: SOLO si el formato los tiene (textOverlayStyle !== null). Invariante:
  // no poner subtítulos salvo que se pidan → sin overlay style, NO se crea criterio.
  if (analysis.visualStyleProfile?.textOverlayStyle) {
    criteria.push({
      id: 'captions.legibles',
      dimension: 'captions-anotacion',
      criterion:
        'Los subtítulos del formato son legibles en móvil (tamaño/contorno adecuados) y coherentes con el estilo del original; no amateur ni recortados.',
      weight: 2,
      failSeverity: 'low',
      derivedFrom: 'analysis.visualStyleProfile.textOverlayStyle',
      confidence: 'inferido',
    });
  }

  // ── global: antes/después (invariante duro) ──────────────────────────────────
  if (isBeforeAfterFormat(analysis)) {
    criteria.push({
      id: 'global.antes-hinchado-progresion',
      dimension: 'global',
      criterion:
        'En el formato antes/después, el "antes" se ve HINCHADO/inflamado (mejillas y párpados hinchados, papada blanda) con tono de piel SANO y SIN moretones ni ojeras tipo golpe; y MEJORA progresivamente a lo largo del ad.',
      weight: 5,
      failSeverity: 'critical',
      derivedFrom: 'editorialLine/summary (antes/después)',
      confidence: 'firme',
    });
  }

  // ── fidelidad global del formato (siempre que haya original que comparar) ─────
  criteria.push({
    id: 'fidelidad.formato',
    dimension: 'fidelidad',
    criterion:
      'El render reproduce el FORMATO del original (estructura, encuadres, densidad de cortes, ritmo, paleta y estilo de edición), no una copia pixel a pixel; lo que se ve "de IA"/amateur frente al original es un fallo.',
    weight: 3,
    failSeverity: 'medium',
    derivedFrom: 'analysis (formato global)',
    confidence: 'inferido',
  });

  const byDimension = emptyByDimension();
  for (const c of criteria) byDimension[c.dimension].push(c);

  const formatLabel = analysis.product?.name
    ? `Formato de "${analysis.product.name}"`
    : 'Formato aprendido';

  return {
    formatLabel,
    criteria,
    byDimension,
    requiredComponents: [...plan.componentsToGenerate],
    acceptanceSummary: `El render PASA si cumple los ${criteria.length} criterios del formato; los de severidad alta/crítica son bloqueantes.`,
  };
}

/** Serializa la rúbrica a texto para anteponerla al contextText del panel. */
export function serializeRubricForPrompt(rubric: Rubric): string {
  const lines: string[] = [];
  lines.push(`RÚBRICA DEL FORMATO — ${rubric.formatLabel}`);
  lines.push(rubric.acceptanceSummary);
  if (rubric.requiredComponents.length > 0) {
    lines.push(`Componentes que el render DEBE tener (su ausencia es fallo): ${rubric.requiredComponents.join(', ')}.`);
  }
  lines.push('');
  lines.push('Criterios a verificar (estado CORRECTO esperado; reporta hallazgo SOLO si NO se cumple):');
  for (const c of rubric.criteria) {
    const tgt = c.target
      ? ` [objetivo: ${c.target.metric}=${c.target.value}${c.target.unit ?? ''} ±${c.target.tolerance}]`
      : '';
    lines.push(`  - (${c.dimension}, corte ${c.failSeverity}) ${c.criterion}${tgt}`);
  }
  return lines.join('\n');
}

// ─── Entrada de la compuerta ───────────────────────────────────────────────────

export interface QualityGateInput {
  /** runId → resuelve <RUNS_DIR>/<runId>/final.mp4 por convención (vía paths.ts). */
  runId?: string;
  /** Alternativa directa al runId. */
  renderVideoPath?: string;
  renderKeyframePaths?: string[];
  /** Original de referencia — NO vive en el run dir; se pasa explícito. Sin él se
   *  saltan las dimensiones que requieren 'original' (fidelidad, voces, animación). */
  originalVideoPath?: string;
  originalKeyframePaths?: string[];
  /** Etiqueta legible para el owner. */
  label?: string;
  /** Contexto del formato (narración/transcripción/preset). Si se pasa rubric, se
   *  serializa y se antepone aquí. */
  contextText?: string;
  /** Rúbrica derivada del formato aprendido. Afina los briefs por dimensión.
   *  Opcional: sin ella el panel corre con sus briefs genéricos. */
  rubric?: Rubric;
  /** Análisis del formato aprendido (AdAnalysis). Si NO se pasa `rubric` pero SÍ
   *  `analysis`, la compuerta DERIVA la rúbrica (deriveRubric) y la usa para el
   *  panel y el juez. Es lo que conecta "rúbrica específica del formato" al camino
   *  real (sin esto, deriveRubric quedaba como código muerto en ejecución). */
  analysis?: AdAnalysis;
  /** Plan de timeline del formato. Si se pasa `analysis` sin `plan`, se deriva con
   *  planTimelineFromFormat(analysis). Solo se usa para derivar la rúbrica. */
  plan?: FormatTimelinePlan;
  /** Mapa de movimiento (animado/estático) del original — afina los criterios de
   *  ritmo/animación de la rúbrica derivada. Opcional. */
  motion?: { cuts: number[]; animatedPct: number };
  /** 'rapido' = Haiku (default), 'profundo' = Sonnet. */
  depth?: 'rapido' | 'profundo';
  /** Política de decisión. Default: env VF_GATE_*; si no, DEFAULT_GATE_POLICY. */
  policy?: Partial<GatePolicy>;
  /** FASE 2: enchufa el juez Gemini video+audio (render-quality-judge) como un
   *  especialista MÁS vía deps.extraSpecialists. Default: lee VF_GATE_USE_GEMINI.
   *  Sin él, corre solo el panel sobre keyframes (fase 1). */
  useGemini?: boolean;
  /** Inyección para tests deterministas (re-expuesto hacia runFormatAudit.deps). */
  deps?: FormatAuditDeps;
}

/** ¿El juez Gemini video+audio está activado por entorno? (VF_GATE_USE_GEMINI=1) */
export function geminiJudgeEnabledByEnv(): boolean {
  const v = process.env['VF_GATE_USE_GEMINI'];
  return v === '1' || v === 'true';
}

// ─── API pública ───────────────────────────────────────────────────────────────

/** ¿Hay credenciales para correr el panel? (= formatAuditEnabled de format-audit.ts) */
export function gateEnabled(): boolean {
  return formatAuditEnabled();
}

/** ¿El estado del hallazgo CUENTA para el veredicto? 'confirmado' siempre; 'abierto'
 *  solo si countUnverified; 'falso-positivo'/'descartado'/'arreglado' NUNCA. */
function estadoCuenta(estado: HallazgoEstado, countUnverified: boolean): boolean {
  if (estado === 'confirmado') return true;
  if (estado === 'abierto') return countUnverified;
  return false;
}

/** El subsistema del Hallazgo viene como '[especialista] título'. Extrae la dimensión. */
function dimensionDe(h: Hallazgo): string {
  const m = h.titulo.match(/^\[([^\]]+)\]/);
  if (m && m[1]) return m[1];
  return h.subsistema || 'global';
}

/** Quita el prefijo '[especialista] ' del título para mostrarlo limpio. */
function tituloLimpio(h: Hallazgo): string {
  return h.titulo.replace(/^\[[^\]]+\]\s*/, '');
}

function toBlocker(h: Hallazgo): GateBlocker {
  return {
    dimension: dimensionDe(h),
    severidad: h.severidad,
    estado: h.estado,
    titulo: tituloLimpio(h),
    fixPropuesto: h.fixPropuesto,
    confianza: h.confianza,
  };
}

/** Ordena por severidad (desc) y luego por confianza (desc). */
function ordenarBlockers(a: GateBlocker, b: GateBlocker): number {
  const d = SEVERITY_RANK[b.severidad] - SEVERITY_RANK[a.severidad];
  return d !== 0 ? d : b.confianza - a.confianza;
}

/**
 * FUNCIÓN PURA, sin IA, testeable: deriva el veredicto de los hallazgos.
 *   - 'fail'    si ∃ hallazgo con severidad ≥ policy.failOn en estado contable;
 *   - 'revisar' si ∃ severidad ≥ policy.reviewOn, o ≥ reviewOnMediumCount 'medium';
 *   - 'pass'    en otro caso.
 * "Contable" = 'confirmado' siempre; 'abierto' solo si policy.countUnverified.
 */
export function decideGateVerdict(
  result: FormatAuditResult,
  policy: GatePolicy,
): {
  veredicto: GateVeredicto;
  bloqueantes: GateBlocker[];
  recomendaciones: GateBlocker[];
  resumen: string;
} {
  const failRank = SEVERITY_RANK[policy.failOn];
  const reviewRank = SEVERITY_RANK[policy.reviewOn];

  const contables = result.hallazgos.filter((h) => estadoCuenta(h.estado, policy.countUnverified));

  // Severidad ≥ failOn ⇒ dispara 'fail'. ≥ reviewOn (y < failOn) ⇒ dispara 'revisar'.
  const failers = contables.filter((h) => SEVERITY_RANK[h.severidad] >= failRank);
  const reviewers = contables.filter(
    (h) => SEVERITY_RANK[h.severidad] >= reviewRank && SEVERITY_RANK[h.severidad] < failRank,
  );
  const mediums = contables.filter((h) => h.severidad === 'medium');
  const mediumTrigger = mediums.length >= policy.reviewOnMediumCount;

  // hallazgosBloqueantes = los Hallazgos (no blockers) que justifican el veredicto;
  // de ahí salen tanto los bloqueantes como, por diferencia, las recomendaciones.
  let veredicto: GateVeredicto;
  let hallazgosBloqueantes: Hallazgo[];
  if (failers.length > 0) {
    veredicto = 'fail';
    // Justifican el fail los críticos/altos que lo disparan + los de nivel revisión.
    hallazgosBloqueantes = [...failers, ...reviewers];
  } else if (reviewers.length > 0 || mediumTrigger) {
    veredicto = 'revisar';
    // Si hay hallazgos de nivel revisión, esos; si no, el cúmulo de 'medium' que disparó.
    hallazgosBloqueantes = reviewers.length > 0 ? reviewers : mediums;
  } else {
    veredicto = 'pass';
    hallazgosBloqueantes = [];
  }

  const idsBloqueantes = new Set(hallazgosBloqueantes.map((h) => h.id));
  const bloqueantes = hallazgosBloqueantes.map(toBlocker).sort(ordenarBlockers);
  // Recomendaciones = todo lo contable que NO entró como bloqueante (surface-only,
  // NUNCA se aplican solas).
  const recomendaciones = contables
    .filter((h) => !idsBloqueantes.has(h.id))
    .map(toBlocker)
    .sort(ordenarBlockers);

  const resumen = construirResumen(veredicto, bloqueantes, recomendaciones, contables.length);
  return { veredicto, bloqueantes, recomendaciones, resumen };
}

function construirResumen(
  veredicto: GateVeredicto,
  bloqueantes: GateBlocker[],
  recomendaciones: GateBlocker[],
  totalContables: number,
): string {
  if (veredicto === 'fail') {
    const top = bloqueantes[0];
    return `FALLA: el render tiene ${bloqueantes.length} problema(s) bloqueante(s)${
      top ? ` (el más grave: ${top.titulo})` : ''
    }. No publicar hasta corregirlos.`;
  }
  if (veredicto === 'revisar') {
    return `REVISAR: el render no tiene fallas críticas, pero hay ${bloqueantes.length} punto(s) a revisar${
      recomendaciones.length ? ` y ${recomendaciones.length} recomendación(es) menor(es)` : ''
    } antes de publicar.`;
  }
  return totalContables > 0
    ? `PASA: sin problemas bloqueantes. ${recomendaciones.length} recomendación(es) menor(es) opcional(es).`
    : 'PASA: el panel no detectó problemas en el render.';
}

/**
 * Orquestador de la COMPUERTA. Resuelve la ruta del render → (opcional) deriva
 * contexto/rúbrica → corre runFormatAudit → decideGateVerdict → persiste el
 * veredicto. NUNCA aplica fixes (solo propone). Best-effort en persistencia.
 */
export async function runQualityGate(input: QualityGateInput): Promise<QualityGateReport> {
  const ts = new Date().toISOString();
  const gateId = `quality-gate/${ts.slice(0, 10)}/${randomUUID().slice(0, 8)}`;

  // 1) Resolver la ruta del render. runId → <RUNS_DIR>/<runId>/final.mp4 (paths.ts,
  //    NUNCA process.cwd() — invariante storage único).
  let renderVideoPath = input.renderVideoPath;
  if (!renderVideoPath && input.runId) {
    renderVideoPath = resolve(RUNS_DIR, input.runId, 'final.mp4');
  }

  // 2) Construir el scope estable y la etiqueta legible.
  const scope = input.runId
    ? `gate:${input.runId}`
    : renderVideoPath
      ? `gate:${createHash('sha1').update(renderVideoPath).digest('hex').slice(0, 12)}`
      : `gate:${gateId.slice(-8)}`;
  const label = input.label ?? (input.runId ? `Compuerta run ${input.runId}` : 'Compuerta de calidad');

  // 3) Resolver la RÚBRICA. Si no viene explícita pero hay `analysis`, la DERIVAMOS
  //    (deriveRubric, determinista). Esto es lo que conecta la rúbrica específica
  //    del formato al camino real: antes deriveRubric era código muerto porque el
  //    único entry-point (la CLI) llamaba sin rubric → el juez corría "ciego" de
  //    criterios. El plan se deriva del análisis si no se pasó.
  const rubric: Rubric | undefined =
    input.rubric ??
    (input.analysis
      ? deriveRubric(
          input.analysis,
          input.plan ?? planTimelineFromFormat(input.analysis),
          input.motion,
        )
      : undefined);

  // 3b) Componer el contextText del PANEL (rúbrica serializada antepuesta, si la
  //     hay). Los especialistas del panel solo leen texto, así que la rúbrica les
  //     llega serializada aquí.
  let contextText = input.contextText ?? '';
  if (rubric) {
    contextText = `${serializeRubricForPrompt(rubric)}\n\n${contextText}`.trim();
  }

  // 4) Política efectiva (defaults < env < override).
  const policy = resolvePolicy(input.policy);

  const comparedWithOriginal = !!(input.originalVideoPath || input.originalKeyframePaths?.length);

  // 4b) FASE 2 opt-in: si se pide Gemini (flag o env) y hay un render en disco,
  //     enchufamos el juez video+audio como un especialista MÁS vía deps. Import
  //     dinámico para que la fase 1 no dependa del transporte Gemini.
  const wantGemini = (input.useGemini ?? geminiJudgeEnabledByEnv()) && !!renderVideoPath;
  let deps = input.deps;
  if (wantGemini && renderVideoPath) {
    const renderPath = renderVideoPath;
    const extra = {
      especialista: 'render-av',
      run: async (_args: { contextText: string; model: string }) => {
        const { renderQualityJudge } = await import('../render-quality-judge');
        return renderQualityJudge({
          renderVideoPath: renderPath,
          originalVideoPath: input.originalVideoPath,
          // IMPORTANTE: pasamos el contexto CRUDO del caller (NO el del panel, que ya
          // lleva la rúbrica serializada + el motion-map) y la rúbrica como OBJETO.
          // El juez serializa sus DIMENSIONES ACTIVAS + criterios él mismo en
          // buildUserText → así la rúbrica entra UNA sola vez (no duplicada). El
          // motion-map es redundante para el juez: ve el video temporal directo.
          contextText: input.contextText,
          rubric,
        });
      },
      // FIX 5: el juez AV trae su PROPIO "verificador" — un passthrough que NO
      // refuta. El verificador por defecto es solo-texto y CIEGO: mataría hallazgos
      // AV legítimos (lipsync, ritmo, audio) que no puede ver. Dejamos sus drafts
      // 'abierto' (que cuentan con countUnverified=true) en vez de 'falso-positivo'.
      verify: async () => ({
        veredicto: 'incierto' as const,
        razon:
          'Hallazgo de un juez que VE+OYE el video (render-av); el verificador de texto es ciego a lipsync/ritmo/audio, así que NO se refuta aquí. Se mantiene abierto para revisión.',
      }),
    };
    deps = { ...(input.deps ?? {}), extraSpecialists: [...(input.deps?.extraSpecialists ?? []), extra] };
  }

  // 5) Correr el panel multi-agente con visión (núcleo reutilizado). El panel
  //    persiste hallazgos + refleja a la KB; la compuerta NO agrega emisores.
  const result = await runFormatAudit({
    scope,
    label,
    renderVideoPath,
    originalVideoPath: input.originalVideoPath,
    renderKeyframePaths: input.renderKeyframePaths,
    originalKeyframePaths: input.originalKeyframePaths,
    contextText: contextText || undefined,
    depth: input.depth,
    deps,
  });

  // 6) Veredicto DETERMINISTA.
  const decision = decideGateVerdict(result, policy);
  let veredicto = decision.veredicto;
  let bloqueantes = decision.bloqueantes;
  let resumen = decision.resumen;
  const recomendaciones = decision.recomendaciones;

  // 6b) FIX 3 — FAIL-CLOSED del juez AV. decideGateVerdict solo mira `hallazgos`;
  //     si pediste Gemini y el juez render-av NO pudo evaluar (cuota/timeout/parse →
  //     entró a result.errores como "especialista render-av: …"), antes la compuerta
  //     decía PASA sin que nadie mirara el render en AV (fail-open: el bug más
  //     peligroso de una "compuerta"). Ahora, si el juez AV fallaba y el veredicto
  //     no es ya 'fail', lo degradamos a 'revisar' con un bloqueante sintético. NO
  //     pisamos un 'fail' real (sería menos estricto).
  const judgeFailed =
    wantGemini && result.errores.some((e) => /(^|\s)especialista\s+render-av:/i.test(e));
  if (judgeFailed && veredicto !== 'fail') {
    const syntheticBlocker: GateBlocker = {
      dimension: 'render-av',
      severidad: 'high',
      estado: 'abierto',
      titulo: 'El juez AV no pudo evaluar el render',
      fixPropuesto:
        'Reintenta la compuerta con Gemini (revisa cuota/credenciales del transporte de video). No publiques como aprobado: nadie verificó lipsync/ritmo/audio del render.',
      confianza: 1,
    };
    veredicto = 'revisar';
    bloqueantes = [syntheticBlocker, ...bloqueantes];
    resumen = `REVISAR: el juez de video+audio (Gemini) no pudo evaluar el render (${
      bloqueantes.length - 1
    } otro(s) punto(s)); no se puede aprobar a ciegas. Reintenta la compuerta antes de publicar.`;
  }

  // 7) Ensamblar + persistir el veredicto (best-effort, scoped).
  const policyRecord: GatePolicyRecord = {
    failOn: policy.failOn,
    reviewOn: policy.reviewOn,
    reviewOnMediumCount: policy.reviewOnMediumCount,
    countUnverified: policy.countUnverified,
  };
  const report: QualityGateReport = {
    schemaVersion: 1,
    gateId,
    scope,
    label,
    ts,
    codeVersion: result.codeVersion,
    veredicto,
    comparedWithOriginal,
    resumen,
    bloqueantes,
    recomendaciones,
    auditId: result.auditId,
    policy: policyRecord,
    especialistasAuditados: result.especialistasAuditados,
    especialistasSalteados: result.especialistasSalteados,
    errores: result.errores,
  };
  await writeQualityGateReport(report);

  return report;
}

// ─── Bucle de reparación dirigida (Lente C) — FASE 2, solo interfaz tipada ─────
// Fase 1 NO repara: la compuerta DECIDE y PROPONE (invariante "nada se auto-aplica").
// El bucle se entrega como interfaz para que fase 2 lo implemente sin reabrir el
// diseño. Reparar un ARTEFACTO del run (output efímero) = permitido; cambiar el
// sistema (prompt/preset/config) = JAMÁS sin owner.

export type RepairAction =
  | { kind: 'regenerate-image'; sceneIndex: number; correctedImagePrompt: string }
  | { kind: 'reanimate'; sceneIndex: number; correctedMotionPrompt: string }
  | { kind: 'extend-duration' | 'trim-duration'; sceneIndex: number; newEndSec: number }
  | { kind: 'regenerate-scene'; sceneIndex: number }
  | { kind: 'surface-to-editor' } // recorte/caption/anotación = capa de edición (no auto)
  | { kind: 'escalate' }; // sistémico → revisión manual

export interface RepairTarget {
  blocker: GateBlocker;
  target: 'image' | 'motion' | 'timing' | 'composite' | 'systemic';
  sceneIndex: number | null;
  action: RepairAction;
}

/**
 * FASE 2: traduce los bloqueantes del veredicto a reparaciones dirigidas, sin
 * re-llamar IA (determinista, por la dimensión/especialista emisor). Localiza el
 * componente que falla → propone regenerar SOLO ese. La EJECUCIÓN la decide el
 * caller (executor inyectado), respetando "nada se auto-aplica" para el sistema.
 */
export interface RepairLoop {
  planRepairs(report: QualityGateReport): RepairTarget[];
}
