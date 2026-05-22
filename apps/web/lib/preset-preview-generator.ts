// Generador de GIF preview para presets aprendidos.
//
// Cuando un run con preset learned-* termina exitosamente, generamos un GIF
// corto (3-5s, ~300px) que se guarda como packages/presets/<id>.preview.gif.
// Después /create lo muestra cuando el user selecciona el preset, para que
// vea qué tipo de video va a construir.
//
// Implementación: usamos el ffmpeg bundled con Remotion compositor (ya está
// instalado como dep transitiva). Si por algún motivo no está disponible,
// degradamos silenciosamente (el preset queda sin preview pero sigue siendo
// usable).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS_DIR, PENDING_PRESETS_DIR } from './paths';
import { findFfmpegPath } from './ffmpeg-locator';

export interface GenerateGifOptions {
  /** MP4 de origen */
  inputMp4Path: string;
  /** Path donde escribir el .gif */
  outputGifPath: string;
  /** Segundo de inicio. Default 1 (skip primer frame que puede ser flash) */
  startSec?: number;
  /** Duración del GIF. Default 4s */
  durationSec?: number;
  /** Ancho del GIF en px. Default 300. Altura proporcional. */
  widthPx?: number;
  /** FPS del GIF. Default 10. Más alto = más fluido pero pesa más */
  fps?: number;
}

/**
 * Genera un GIF corto desde un MP4. Resuelve con true si tuvo éxito, false si
 * ffmpeg no está disponible o falló (sin tirar para que el caller decida).
 */
export async function generateGif(opts: GenerateGifOptions): Promise<boolean> {
  if (!existsSync(opts.inputMp4Path)) return false;
  const ffmpegBin = findFfmpegPath();
  if (!ffmpegBin) return false;

  const start = opts.startSec ?? 1;
  const duration = opts.durationSec ?? 4;
  const width = opts.widthPx ?? 300;
  const fps = opts.fps ?? 10;

  const args = [
    '-y', // sobrescribir output si existe
    '-ss',
    String(start),
    '-t',
    String(duration),
    '-i',
    opts.inputMp4Path,
    '-vf',
    `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
    '-loop',
    '0',
    opts.outputGifPath,
  ];

  return new Promise<boolean>((resolveFn) => {
    let stderr = '';
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', () => {
      // Probablemente el binario no existe / no se puede ejecutar
      resolveFn(false);
    });
    proc.on('close', (code) => {
      if (code === 0 && existsSync(opts.outputGifPath)) {
        resolveFn(true);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[preset-preview] ffmpeg exit ${code}. stderr: ${stderr.slice(-300)}`);
        resolveFn(false);
      }
    });
  });
}

/**
 * Resuelve dónde está físicamente el .preset.json para un id dado: en
 * PRESETS_DIR (aprobado) o PENDING_PRESETS_DIR (pendiente de aprobación).
 * El .preview.gif siempre va al lado del .preset.json correspondiente.
 */
function resolvePresetDir(presetId: string): string {
  const approvedPath = join(PRESETS_DIR, `${presetId}.preset.json`);
  if (existsSync(approvedPath)) return PRESETS_DIR;
  return PENDING_PRESETS_DIR;
}

/**
 * Genera el preview de un preset aprendido desde el final.mp4 de un run.
 * Si el preset NO empieza con "learned-", retorna sin hacer nada (los presets
 * manuales no necesitan auto-preview).
 *
 * El .gif se guarda AL LADO del .preset.json, en PRESETS_DIR si está aprobado
 * o en PENDING_PRESETS_DIR si todavía está pendiente. Cuando el admin apruebe
 * el preset, ambos files (.preset.json + .preview.gif) se mueven juntos.
 *
 * Idempotente: si el preview ya existe, NO lo regenera (el primer run "gana").
 */
export async function generateLearnedPresetPreview(
  presetId: string,
  runOutputMp4Path: string,
): Promise<{ success: boolean; previewPath: string | null }> {
  if (!presetId.startsWith('learned-')) {
    return { success: false, previewPath: null };
  }
  const presetDir = resolvePresetDir(presetId);
  const previewPath = join(presetDir, `${presetId}.preview.gif`);
  if (existsSync(previewPath)) {
    return { success: true, previewPath };
  }
  const ok = await generateGif({
    inputMp4Path: runOutputMp4Path,
    outputGifPath: previewPath,
  });
  return { success: ok, previewPath: ok ? previewPath : null };
}
