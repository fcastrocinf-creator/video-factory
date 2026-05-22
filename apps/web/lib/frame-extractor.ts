// Frame extractor: extrae N keyframes representativos de un MP4 usando ffmpeg.
// Reusa el ffmpeg bundled con @remotion/compositor-* (no requiere install global).
//
// Estrategia: tomamos keyframes a tiempos equiespaciados en el video. NO usamos
// scene detection de ffmpeg (-vf select=scene) porque es heurística y a veces da
// muy pocos frames en ads cortos. Una distribución uniforme es predecible y
// suficiente para que el style-trainer aprenda el look general.

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findFfmpegPath } from './ffmpeg-locator';

/**
 * Obtiene duración del video en segundos usando ffprobe (que viene con ffmpeg).
 * Si no podemos parsearlo, devuelve null y el caller usa un default razonable.
 */
export async function getVideoDurationSec(videoPath: string): Promise<number | null> {
  const ffmpegBin = findFfmpegPath();
  // ffmpeg sin args útiles tira los metadata por stderr — los parseamos
  return new Promise((resolveFn) => {
    let stderr = '';
    const proc = spawn(ffmpegBin, ['-i', videoPath, '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    proc.on('error', () => resolveFn(null));
    proc.on('close', () => {
      // Buscamos "Duration: HH:MM:SS.MS" en stderr
      const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (!m) return resolveFn(null);
      const [, hh, mm, ss, cs] = m;
      const total =
        Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(cs) / 100;
      resolveFn(total);
    });
  });
}

export interface ExtractedKeyframe {
  index: number;
  /** Segundo en el video original donde se capturó */
  sourceTimeSec: number;
  /** Path absoluto del PNG extraído */
  filePath: string;
}

export interface ExtractKeyframesOptions {
  videoPath: string;
  /** Directorio donde escribir los PNGs (se crea si no existe) */
  outputDir: string;
  /** Cuántos keyframes. Si no se pasa, se infiere de la duración. */
  count?: number;
  /** Width target en píxeles. Default 720 (suficiente para vision compare) */
  widthPx?: number;
}

/**
 * Decide cuántos keyframes extraer según duración del video.
 * - <= 15s → 3 frames (hook + medio + cierre)
 * - 16-45s → 5 frames
 * - 46-90s → 7 frames
 * - > 90s  → 9 frames
 */
function inferKeyframeCount(durationSec: number): number {
  if (durationSec <= 15) return 3;
  if (durationSec <= 45) return 5;
  if (durationSec <= 90) return 7;
  return 9;
}

/**
 * Extrae N keyframes equiespaciados de un MP4. Devuelve los paths de los PNGs
 * generados. Si ffmpeg falla, lanza error claro.
 */
export async function extractKeyframes(
  opts: ExtractKeyframesOptions,
): Promise<ExtractedKeyframe[]> {
  if (!existsSync(opts.videoPath)) {
    throw new Error(`Video no encontrado: ${opts.videoPath}`);
  }
  await mkdir(opts.outputDir, { recursive: true });

  const duration = (await getVideoDurationSec(opts.videoPath)) ?? 30;
  const count = opts.count ?? inferKeyframeCount(duration);
  const widthPx = opts.widthPx ?? 720;
  const ffmpegBin = findFfmpegPath();

  // Distribución: para count=5 y duración=30s → tiempos [3, 9, 15, 21, 27]
  // (no tomamos t=0 ni t=duration porque suelen ser fade-in/fade-out)
  const margin = duration * 0.1; // 10% margen en cada extremo
  const usable = duration - margin * 2;
  const step = count > 1 ? usable / (count - 1) : 0;
  const times: number[] = Array.from({ length: count }, (_, i) => margin + step * i);

  const keyframes: ExtractedKeyframe[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const outPath = join(opts.outputDir, `keyframe_${String(i).padStart(2, '0')}.png`);
    await new Promise<void>((resolveFn, reject) => {
      let stderr = '';
      const proc = spawn(
        ffmpegBin,
        [
          '-y',
          '-ss',
          t.toFixed(2),
          '-i',
          opts.videoPath,
          '-frames:v',
          '1',
          '-vf',
          `scale=${widthPx}:-2:flags=lanczos`,
          outPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      proc.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf-8');
      });
      proc.on('error', (err) =>
        reject(new Error(`ffmpeg spawn failed (${err.message}). Bin: ${ffmpegBin}`)),
      );
      proc.on('close', (code) => {
        if (code === 0 && existsSync(outPath)) {
          resolveFn();
        } else {
          reject(
            new Error(
              `ffmpeg exit ${code} extrayendo keyframe ${i} (t=${t.toFixed(2)}s). stderr: ${stderr.slice(-200)}`,
            ),
          );
        }
      });
    });
    keyframes.push({ index: i, sourceTimeSec: t, filePath: outPath });
  }

  return keyframes;
}

/**
 * Lee un archivo de imagen y lo devuelve como buffer base64 + dimensión inferida.
 * Útil para passar a Gemini Vision o providers de imagen.
 */
export async function readImageAsBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString('base64');
}

/**
 * Lista los archivos en un directorio que matchean un patrón. Útil para listar
 * iteraciones de un frame durante la trayectoria.
 */
export async function listFilesMatching(
  dir: string,
  pattern: RegExp,
): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return files.filter((f) => pattern.test(f)).sort();
}
