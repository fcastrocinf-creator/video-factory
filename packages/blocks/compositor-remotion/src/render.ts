import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { PlanoFijoProps } from './compositions/PlanoFijo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RenderPlanoFijoOptions {
  outputPath: string;
  workDir: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  inputProps: PlanoFijoProps;
  onProgress?: (progress: number) => void;
}

export interface RenderResult {
  outputPath: string;
  sizeBytes: number;
  durationSeconds: number;
}

// Bundle del proyecto Remotion + render del composition "PlanoFijo".
// publicDir = workDir → staticFile('audio.mp3') sirve desde el workDir del run.
export async function renderPlanoFijo(options: RenderPlanoFijoOptions): Promise<RenderResult> {
  const entryPoint = resolve(__dirname, 'compositions/Root.tsx');

  const bundleLocation = await bundle({
    entryPoint,
    publicDir: options.workDir,
    webpackOverride: (config) => config,
  });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'PlanoFijo',
    inputProps: options.inputProps as unknown as Record<string, unknown>,
  });

  await renderMedia({
    composition: {
      ...composition,
      durationInFrames: options.durationInFrames,
      fps: options.fps,
      width: options.width,
      height: options.height,
    },
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: options.outputPath,
    inputProps: options.inputProps as unknown as Record<string, unknown>,
    onProgress: options.onProgress
      ? ({ progress }) => options.onProgress?.(progress)
      : undefined,
  });

  const { statSync } = await import('node:fs');
  const stat = statSync(options.outputPath);

  return {
    outputPath: options.outputPath,
    sizeBytes: stat.size,
    durationSeconds: options.durationInFrames / options.fps,
  };
}
