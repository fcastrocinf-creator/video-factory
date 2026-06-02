// video-intelligence.ts — Capa de PERCEPCIÓN de video del proyecto ("entender videos
// complejos lo mejor posible"). Orquesta lo que ya existe, sin reinventar:
//
//   1. NÚCLEO — Gemini 2.5 Pro NATIVO (analyzeAd): ve + OYE + entiende temporalmente el
//      video completo → guión, escenas con timestamps, narrador, producto, línea
//      editorial, estilo, PiP/overlays, captions. Es lo más fuerte (no son solo frames).
//   2. NUESTRO motion-map: cortes (cambios de plano) + tramos animado/estático.
//   3. Persiste un "formato aprendido" (JSON + evento KB) → memoria que MEJORA con cada video.
//
// Capas siguientes (apilables): keyframes densos para registro visual, panel
// multi-agente de verificación (format-audit), diarización por hablante.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeAd } from './ad-analyzer';
import type { AdAnalysis } from '@video-factory/contracts';
import { buildMotionMap, type MotionMap } from './motion-map';
import { KB_DIR, recordEvent, type KbSubsistema } from './kb/record';
import { planTimelineFromFormat, type FormatTimelinePlan } from './format-to-timeline';

export interface VideoIntelligenceReport {
  videoPath: string;
  durationSec: number;
  /** Análisis nativo de Gemini (guión, escenas, narrador, producto, estilo). */
  analysis: AdAnalysis;
  /** Estructura de movimiento propia: cortes + animado/estático. */
  motion: {
    animatedPct: number;
    cuts: number[];
    segments: MotionMap['segments'];
  };
  /** Plan de edición (reproducción) deducido del formato aprendido. */
  timelinePlan: FormatTimelinePlan;
  ts: string;
}

export interface AnalyzeVideoDeepOptions {
  videoPath: string;
  mimeType?: string;
  /** Persistir el formato aprendido (JSON + KB). Default true. */
  persist?: boolean;
}

/**
 * Comprensión PROFUNDA de un video: Gemini nativo (visual+audio+tiempo) + motion-map
 * (cortes) + persistencia como formato aprendido. Es la base de la capacidad de
 * "aprender un formato" del proyecto.
 */
export async function analyzeVideoDeep(
  opts: AnalyzeVideoDeepOptions,
): Promise<VideoIntelligenceReport> {
  // 1) Núcleo: Gemini nativo.
  const analysis = await analyzeAd({ videoPath: opts.videoPath, mimeType: opts.mimeType });

  // 2) Mapa de movimiento (cortes + animado/estático). Best-effort.
  let motion: VideoIntelligenceReport['motion'] = { animatedPct: 0, cuts: [], segments: [] };
  try {
    const map = await buildMotionMap({ videoPath: opts.videoPath, sampleFps: 4 });
    const meanM = map.samples.reduce((a, s) => a + s.motionPct, 0) / Math.max(1, map.samples.length);
    const cuts = map.samples.filter((s) => s.motionPct > Math.max(12, meanM * 3)).map((s) => s.t);
    motion = { animatedPct: map.summary.animatedPct, cuts, segments: map.segments };
  } catch {
    // el análisis de Gemini sigue siendo válido sin el mapa
  }

  const report: VideoIntelligenceReport = {
    videoPath: opts.videoPath,
    durationSec: analysis.totalDurationSeconds,
    analysis,
    motion,
    timelinePlan: planTimelineFromFormat(analysis),
    ts: new Date().toISOString(),
  };

  if (opts.persist !== false) {
    // a) JSON completo (store de formatos aprendidos).
    try {
      const dir = resolve(KB_DIR, 'formatos');
      await mkdir(dir, { recursive: true });
      const safe =
        (opts.videoPath.split(/[/\\]/).pop() ?? 'video')
          .replace(/[^a-zA-Z0-9._-]+/g, '_')
          .slice(0, 80) || 'video';
      await writeFile(resolve(dir, `${safe}.json`), JSON.stringify(report, null, 2), 'utf-8');
    } catch {
      // best-effort
    }
    // b) Evento a la KB (memoria que mejora con cada video aprendido).
    const tags = ['formato-aprendido', ...(analysis.visualStyleProfile?.aestheticTags ?? [])];
    void recordEvent({
      vault: 'dev',
      subsistema: 'aprendizaje' as KbSubsistema,
      tipo: 'decision',
      entidad: {},
      titulo: `Formato aprendido: ${analysis.summary.slice(0, 90)}`,
      contenido: `Estilo: ${tags.join(', ')}\nLínea editorial: ${analysis.editorialLine}\n\nGuión:\n${analysis.fullNarration.slice(0, 1500)}`,
      fuente: `video-intelligence:${opts.videoPath}`,
      tags,
    });
  }

  return report;
}

/** Resumen compacto del reporte para mostrar al owner (español neutro). */
export function formatVideoIntelligence(report: VideoIntelligenceReport): string {
  const a = report.analysis;
  const shots = a.scenes
    .map((s) => `  ${s.startSec}-${s.endSec}s — ${s.visualDescription}`)
    .join('\n');
  return [
    `VIDEO: ${report.videoPath}  (${report.durationSec}s, ${a.scenes.length} escenas, ${report.motion.cuts.length} cortes, ${report.motion.animatedPct}% animado)`,
    `PRODUCTO: ${a.product?.name ?? '—'}`,
    `HOOK: ${a.hookType}   CTA: ${a.cta}`,
    `NARRADOR: ${a.narratorProfile?.characterCard ?? '—'}`,
    `ESTILO: ${a.visualStyleProfile?.aestheticTags?.join(', ') ?? '—'}`,
    `\nGUIÓN:\n${a.fullNarration}`,
    `\nESCENAS:\n${shots}`,
  ].join('\n');
}
