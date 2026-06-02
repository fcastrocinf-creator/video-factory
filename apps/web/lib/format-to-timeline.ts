// format-to-timeline.ts — Puente ENTENDER → REPRODUCIR ("Estilo CapCut", Fase 2 #2).
//
// Toma el análisis de un ad aprendido (AdAnalysis de ad-analyzer/Gemini, con escenas
// + timestamps + narración) y produce un PLAN DE EDICIÓN segmento-a-segmento: el rol de
// cada plano (autoridad a pantalla / testimonio con PiP / otro), qué hay que generar o
// componer, las anotaciones (zona) y el caption por segmento. Es el "esqueleto" editable
// que luego la generación rellena y el owner ajusta en el editor manual.
//
// Determinista (heurística sobre las descripciones de Gemini). No genera nada ni gasta IA.

import type { AdAnalysis } from '@video-factory/contracts';

export interface TimelineSegmentPlan {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Rol del plano detectado. */
  role: 'authority-fullscreen' | 'user-testimonial-pip' | 'other';
  /** Qué hay que generar/poner en este segmento (acciones para la reproducción). */
  needs: string[];
  /** Caption sugerido (de la narración de este segmento). */
  caption: string;
  /** Anotación a colocar (zona a destacar) o null. */
  annotation: { zone: string } | null;
}

export interface FormatTimelinePlan {
  durationSec: number;
  segments: TimelineSegmentPlan[];
  /** Componentes únicos a generar (deducidos del plan). */
  componentsToGenerate: string[];
}

const RE_AUTHORITY = /m[eé]dico|doctor|bata blanca|estetoscopio/i;
const RE_PIP = /recuadro|superposici|esquina|peque[nñ]a imagen|picture-in-picture|pip/i;
const RE_USER = /mujer|rosa|clienta|usuaria|testimon|paciente/i;
const RE_ANNOT = /c[ií]rculo|c[ií]rculo rojo|se[nñ]ala|gr[aá]fico|flecha|resalta/i;

function detectZone(desc: string): string | null {
  const d = desc.toLowerCase();
  if (d.includes('papada')) return 'papada';
  if (d.includes('ojera')) return 'ojeras';
  if (d.includes('hinchad')) return 'cara hinchada';
  if (RE_ANNOT.test(desc)) return 'zona destacada';
  return null;
}

function classify(desc: string): TimelineSegmentPlan['role'] {
  const isAuthority = RE_AUTHORITY.test(desc);
  const isPip = RE_PIP.test(desc);
  const isUser = RE_USER.test(desc);
  // Mujer en pantalla + médico en recuadro = testimonio con PiP.
  if (isUser && (isPip || isAuthority)) return 'user-testimonial-pip';
  if (isUser && !isAuthority) return 'user-testimonial-pip';
  if (isAuthority && !isUser) return 'authority-fullscreen';
  return 'other';
}

/** Construye el plan de edición a partir del análisis del ad aprendido. */
export function planTimelineFromFormat(analysis: AdAnalysis): FormatTimelinePlan {
  const components = new Set<string>();
  const segments: TimelineSegmentPlan[] = (analysis.scenes ?? []).map((s) => {
    const desc = s.visualDescription ?? '';
    const role = classify(desc);
    const zone = detectZone(desc);
    const needs: string[] = [];

    if (role === 'authority-fullscreen') {
      needs.push('video: experto hablando a cámara (lipsync → HeyGen)');
      components.add('experto-hablando (HeyGen)');
    } else if (role === 'user-testimonial-pip') {
      needs.push('video: usuaria UGC hablando (su estado físico de este momento)');
      needs.push('overlay: experto recortado en PiP (esquina) — asiente / a veces habla');
      components.add('usuaria-UGC (antes/después)');
      components.add('experto-recortado-PiP');
    } else {
      needs.push('video/imagen: plano de apoyo');
    }
    if (zone) {
      needs.push(`anotación: círculo/flecha en "${zone}" (anclar a la zona, sincronizar al caption)`);
      components.add('anotaciones-zona');
    }
    const caption = (s.narrationFragment ?? '').trim();
    if (caption) needs.push('caption: ' + (caption.length > 48 ? caption.slice(0, 46) + '…' : caption));

    return {
      index: s.index,
      startSec: s.startSec,
      endSec: s.endSec,
      durationSec: +(s.endSec - s.startSec).toFixed(2),
      role,
      needs,
      caption,
      annotation: zone ? { zone } : null,
    };
  });

  // Voces: deducir hablantes (autoridad + usuaria) si el formato los tiene.
  const hasAuthority = segments.some((s) => s.role === 'authority-fullscreen' || s.needs.some((n) => n.includes('experto')));
  const hasUser = segments.some((s) => s.role === 'user-testimonial-pip');
  if (hasAuthority) components.add('voz: experto (autoridad)');
  if (hasUser) components.add('voz: usuaria (testimonio)');

  return {
    durationSec: analysis.totalDurationSeconds,
    segments,
    componentsToGenerate: [...components],
  };
}

/** Resumen legible del plan para el owner (español neutro). */
export function formatTimelinePlan(plan: FormatTimelinePlan): string {
  const lines = plan.segments.map(
    (s) => `  ${s.startSec}-${s.endSec}s [${s.role}]${s.annotation ? ` ⊙${s.annotation.zone}` : ''}: ${s.needs.join(' · ')}`,
  );
  return [
    `PLAN DE EDICIÓN (${plan.durationSec}s, ${plan.segments.length} segmentos)`,
    `COMPONENTES A GENERAR: ${plan.componentsToGenerate.join(', ')}`,
    '',
    ...lines,
  ].join('\n');
}
