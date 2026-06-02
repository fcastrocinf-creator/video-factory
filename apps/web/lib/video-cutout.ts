// video-cutout.ts — "Estilo CapCut" Fase 2: recorte de VIDEO por chroma en Node.
//
// Convierte un clip de un sujeto sobre VERDE (lo que produce scene-animator con un
// prompt de fondo croma) en un .webm con ALPHA real, listo para componerse como
// overlay animado (OffthreadVideo transparent). Esto AUTOMATIZA en el pipeline lo
// que antes se hacía a mano: keying + despill por frame.
//
// Por qué a mano y no por filtro ffmpeg: el ffmpeg recortado de Remotion NO trae el
// filtro chromakey (sí los encoders vp9/prores con alpha). Así que decodificamos cada
// frame (PNG), aplicamos chroma+despill por píxel y re-encodeamos a webm vp9 yuva420p.
// (Invariante video-chroma-alpha-webm.)

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFfmpegPath } from './ffmpeg-locator';
import { decodePng, encodePngRGBA } from './png-raw';

export interface PrepareVideoCutoutOptions {
  /** Clip del sujeto sobre fondo verde (mp4/webm). */
  inputVideoPath: string;
  /** Ruta de salida .webm (vp9 con alpha). */
  outputWebmPath: string;
  /**
   * Umbrales de chroma sobre gd = G − max(R,B): gd ≥ t2 ⇒ transparente;
   * t1 < gd < t2 ⇒ rampa de alpha + despill; gd > 4 ⇒ despill. Defaults 45/90
   * (verde saturado tipo Kling/Higgsfield). Bajar para verdes menos puros.
   */
  t1?: number;
  t2?: number;
  /** Bitrate del webm. Default '3M'. */
  bitrate?: string;
}

export interface PrepareVideoCutoutResult {
  outputWebmPath: string;
  frameCount: number;
  fps: number;
}

function spawnFf(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise<void>((resolveFn, reject) => {
    let stderr = '';
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    proc.on('error', (e) => reject(new Error(`ffmpeg cutout spawn: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolveFn();
      else reject(new Error(`ffmpeg cutout exit ${code}: ${stderr.slice(-220)}`));
    });
  });
}

function probeFps(ffmpeg: string, path: string): Promise<number> {
  return new Promise<number>((resolveFn) => {
    let s = '';
    const proc = spawn(ffmpeg, ['-i', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (c: Buffer) => {
      s += c.toString('utf-8');
    });
    proc.on('error', () => resolveFn(24));
    proc.on('close', () => {
      const m = s.match(/([\d.]+)\s*fps/);
      const f = m ? Math.round(parseFloat(m[1]!)) : 24;
      resolveFn(f >= 1 && f <= 60 ? f : 24);
    });
  });
}

/** Chroma + despill de un frame RGB(A) → RGBA recortado. */
function keyFrameToRGBA(src: Buffer, nPx: number, bpp: number, t1: number, t2: number): Buffer {
  const out = Buffer.alloc(nPx * 4);
  for (let p = 0; p < nPx; p++) {
    const si = p * bpp;
    const oi = p * 4;
    const r = src[si]!;
    let g = src[si + 1]!;
    const b = src[si + 2]!;
    const mx = r > b ? r : b;
    const gd = g - mx;
    let a = 255;
    if (gd >= t2) {
      a = 0;
    } else if (gd > t1) {
      a = Math.round((255 * (t2 - gd)) / (t2 - t1));
      g = mx; // despill
    } else if (gd > 4) {
      g = mx; // despill leve
    }
    out[oi] = r;
    out[oi + 1] = g;
    out[oi + 2] = b;
    out[oi + 3] = a;
  }
  return out;
}

/**
 * Recorta el fondo verde de un clip y produce un webm con alpha.
 * Costo: extracción de frames (ffmpeg) + decode/key/encode por frame (Node) +
 * encode webm (ffmpeg). Para clips cortos (overlays) es lo esperado.
 */
export async function prepareVideoCutout(
  opts: PrepareVideoCutoutOptions,
): Promise<PrepareVideoCutoutResult> {
  const t1 = opts.t1 ?? 45;
  const t2 = opts.t2 ?? 90;
  const bitrate = opts.bitrate ?? '3M';
  const ffmpeg = findFfmpegPath();
  const fps = await probeFps(ffmpeg, opts.inputVideoPath);

  const dirIn = mkdtempSync(join(tmpdir(), 'vf-cut-in-'));
  const dirOut = mkdtempSync(join(tmpdir(), 'vf-cut-out-'));
  try {
    await spawnFf(ffmpeg, [
      '-y',
      '-i',
      opts.inputVideoPath,
      '-r',
      String(fps),
      '-pix_fmt',
      'rgb24',
      join(dirIn, 'f_%05d.png'),
    ]);
    const files = readdirSync(dirIn)
      .filter((f) => f.endsWith('.png'))
      .sort();
    if (files.length === 0) throw new Error('no se extrajo ningún frame');
    for (const f of files) {
      const dec = decodePng(readFileSync(join(dirIn, f)));
      const rgba = keyFrameToRGBA(dec.px, dec.w * dec.h, dec.bpp, t1, t2);
      writeFileSync(join(dirOut, f), encodePngRGBA(dec.w, dec.h, rgba));
    }
    await spawnFf(ffmpeg, [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      join(dirOut, 'f_%05d.png'),
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-auto-alt-ref',
      '0',
      '-b:v',
      bitrate,
      opts.outputWebmPath,
    ]);
    return { outputWebmPath: opts.outputWebmPath, frameCount: files.length, fps };
  } finally {
    try {
      rmSync(dirIn, { recursive: true, force: true });
      rmSync(dirOut, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
