// motion-map.ts — "Estilo CapCut" Fase 1: detección de patrones de ANIMACIÓN/MOVIMIENTO.
//
// Un ad mezcla tramos ANIMADOS (el experto se mueve/habla, el usuario prueba el
// producto) y ESTÁTICOS (imágenes fijas). El análisis por keyframes (video-understander)
// NO ve esto. Este módulo produce el "mapa temporal" de movimiento de forma
// DETERMINISTA y barata: extrae frames downscaled (PNG) vía ffmpeg y difiere frames
// consecutivos. La interpretación de QUÉ/QUIÉN se mueve en cada tramo la hace el
// especialista de visión del panel (format-audit.ts).
//
// NOTA (gotcha): el ffmpeg recortado de Remotion NO trae muxer rawvideo ni filtros de
// análisis (freezedetect/scdet), y no hay librería de imágenes en Node. Por eso:
// extraemos PNG (muxer image2, que SÍ funciona) y decodificamos a mano con zlib
// (PNG rgb24/rgba, sin interlace — el caso que produce ffmpeg con -pix_fmt rgb24).
//
// Reusa: findFfmpegPath (ffmpeg-locator) + getVideoDurationSec (frame-extractor).

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { findFfmpegPath } from './ffmpeg-locator';
import { getVideoDurationSec } from './frame-extractor';

export interface MotionSample {
  /** Segundo (en el video) de esta muestra. */
  t: number;
  /** Diferencia media de píxeles vs la muestra anterior, en % (0-100). */
  motionPct: number;
}

export interface MotionSegment {
  t0: number;
  t1: number;
  durationSec: number;
  /** 'animated' = hay movimiento real; 'static' = imagen fija / casi sin cambio. */
  kind: 'animated' | 'static';
  avgMotionPct: number;
}

export interface MotionMap {
  durationSec: number;
  sampleFps: number;
  staticThresholdPct: number;
  samples: MotionSample[];
  segments: MotionSegment[];
  summary: {
    animatedPct: number; // % del tiempo total que es animado
    staticPct: number;
    segmentCount: number;
    avgMotionPct: number;
  };
}

export interface BuildMotionMapOptions {
  videoPath: string;
  /** Muestras por segundo. Default 2 (0.5s entre frames → diff legible). */
  sampleFps?: number;
  /** Lado del cuadro de muestreo en px. Default 72 (barato; suficiente para motion). */
  boxPx?: number;
  /** motion% < umbral ⇒ tramo estático. Default 2. */
  staticThresholdPct?: number;
  /** Segmentos más cortos que esto se fusionan con el vecino. Default 0.8s. */
  minSegmentSec?: number;
}

/** Extrae frames a `fps` (escalados a box×box, rgb24) como PNG a un dir temporal. */
async function extractPngFrames(
  ffmpeg: string,
  videoPath: string,
  fps: number,
  box: number,
  outDir: string,
): Promise<void> {
  await new Promise<void>((resolveFn, reject) => {
    let stderr = '';
    const proc = spawn(
      ffmpeg,
      [
        '-y',
        '-i',
        videoPath,
        '-vf',
        `scale=${box}:${box}`,
        '-r',
        String(fps),
        '-pix_fmt',
        'rgb24',
        join(outDir, 'f_%05d.png'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    proc.on('error', (e) => reject(new Error(`ffmpeg motion-map spawn falló: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolveFn();
      else reject(new Error(`ffmpeg motion-map exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}

/** Decodifica un PNG simple (8-bit, colorType 2 RGB o 6 RGBA, sin interlace) a píxeles. */
function decodePng(buf: Buffer): { w: number; h: number; bpp: number; px: Buffer } {
  let pos = 8; // saltar la firma PNG
  let w = 0;
  let h = 0;
  let colorType = 2;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // len(4) + type(4) + data(len) + crc(4)
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++]!;
      const a = x >= bpp ? px[y * stride + x - bpp]! : 0; // izquierda
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0; // arriba
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp]! : 0; // arriba-izq
      let val: number;
      switch (ft) {
        case 1:
          val = cur + a;
          break;
        case 2:
          val = cur + b;
          break;
        case 3:
          val = cur + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = cur + pr;
          break;
        }
        default:
          val = cur;
      }
      px[y * stride + x] = val & 0xff;
    }
  }
  return { w, h, bpp, px };
}

/** Diferencia media absoluta (%) de canales RGB entre dos frames decodificados. */
function frameDiffPct(a: { px: Buffer; bpp: number }, b: { px: Buffer; bpp: number }): number {
  const len = Math.min(a.px.length, b.px.length);
  const bpp = a.bpp;
  let s = 0;
  let cnt = 0;
  for (let i = 0; i + 2 < len; i += bpp) {
    s += Math.abs(a.px[i]! - b.px[i]!) + Math.abs(a.px[i + 1]! - b.px[i + 1]!) + Math.abs(a.px[i + 2]! - b.px[i + 2]!);
    cnt += 3;
  }
  return cnt > 0 ? (s / (cnt * 255)) * 100 : 0;
}

interface RawSeg {
  t0: number;
  t1: number;
  kind: 'animated' | 'static';
  vals: number[];
}

function buildSegments(
  samples: MotionSample[],
  thr: number,
  fps: number,
  minSeg: number,
  durationSec: number,
): MotionSegment[] {
  if (samples.length === 0) return [];
  const dt = 1 / fps;
  const segs: RawSeg[] = [];
  for (const s of samples) {
    const kind: 'animated' | 'static' = s.motionPct >= thr ? 'animated' : 'static';
    const prev = segs[segs.length - 1];
    if (prev && prev.kind === kind) {
      prev.t1 = s.t;
      prev.vals.push(s.motionPct);
    } else {
      segs.push({ t0: Math.max(0, s.t - dt), t1: s.t, kind, vals: [s.motionPct] });
    }
  }
  // Fusionar segmentos demasiado cortos con un vecino (evita fragmentación).
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i]!.t1 - segs[i]!.t0 < minSeg) {
        const j = i > 0 ? i - 1 : i + 1;
        segs[j]!.t0 = Math.min(segs[i]!.t0, segs[j]!.t0);
        segs[j]!.t1 = Math.max(segs[i]!.t1, segs[j]!.t1);
        segs[j]!.vals = segs[j]!.vals.concat(segs[i]!.vals);
        segs.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return segs.map((r) => ({
    t0: +r.t0.toFixed(2),
    t1: +Math.min(durationSec, r.t1).toFixed(2),
    durationSec: +(Math.min(durationSec, r.t1) - r.t0).toFixed(2),
    kind: r.kind,
    avgMotionPct: +(r.vals.reduce((a, b) => a + b, 0) / r.vals.length).toFixed(2),
  }));
}

/**
 * Construye el mapa de movimiento de un video: muestrea frames a `sampleFps`,
 * difiere consecutivos y segmenta en tramos animados vs estáticos.
 * Costo: 1 corrida ffmpeg (PNG downscale) + decode/diff en memoria. Sin IA.
 */
export async function buildMotionMap(opts: BuildMotionMapOptions): Promise<MotionMap> {
  const fps = opts.sampleFps ?? 2;
  const box = opts.boxPx ?? 72;
  const thr = opts.staticThresholdPct ?? 2;
  const minSeg = opts.minSegmentSec ?? 0.8;
  const ffmpeg = findFfmpegPath();

  const dir = mkdtempSync(join(tmpdir(), 'vf-motion-'));
  try {
    await extractPngFrames(ffmpeg, opts.videoPath, fps, box, dir);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort();
    const durationSec = (await getVideoDurationSec(opts.videoPath)) ?? files.length / fps;

    const samples: MotionSample[] = [];
    let prev: { px: Buffer; bpp: number } | null = null;
    let idx = 0;
    for (const f of files) {
      const cur = decodePng(readFileSync(join(dir, f)));
      if (prev) {
        samples.push({ t: +(idx / fps).toFixed(2), motionPct: +frameDiffPct(prev, cur).toFixed(2) });
      }
      prev = cur;
      idx++;
    }

    const segments = buildSegments(samples, thr, fps, minSeg, durationSec);
    const animatedSec = segments
      .filter((s) => s.kind === 'animated')
      .reduce((a, s) => a + s.durationSec, 0);
    const totalSec = segments.reduce((a, s) => a + s.durationSec, 0) || durationSec || 1;
    const avgMotion =
      samples.length > 0 ? samples.reduce((a, s) => a + s.motionPct, 0) / samples.length : 0;

    return {
      durationSec: +durationSec.toFixed(2),
      sampleFps: fps,
      staticThresholdPct: thr,
      samples,
      segments,
      summary: {
        animatedPct: +((animatedSec / totalSec) * 100).toFixed(1),
        staticPct: +(((totalSec - animatedSec) / totalSec) * 100).toFixed(1),
        segmentCount: segments.length,
        avgMotionPct: +avgMotion.toFixed(2),
      },
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** Texto compacto del mapa para inyectar como contexto a un juez de visión. */
export function formatMotionMapForPrompt(map: MotionMap): string {
  const segs = map.segments
    .map(
      (s) =>
        `  ${s.t0}-${s.t1}s (${s.durationSec}s): ${s.kind === 'animated' ? 'ANIMADO' : 'estático'} (mov ${s.avgMotionPct}%)`,
    )
    .join('\n');
  return `Mapa de movimiento (${map.durationSec}s, ${map.summary.animatedPct}% animado / ${map.summary.staticPct}% estático, ${map.summary.segmentCount} tramos):\n${segs}`;
}
