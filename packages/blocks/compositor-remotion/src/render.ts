import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { PlanoFijoProps } from './compositions/PlanoFijo.js';
import type { PlanoAnimadoProps } from './compositions/PlanoAnimado.js';
import type { PlanoEscenasProps } from './compositions/PlanoEscenas.js';
import type { ComposicionAvanzadaProps } from './compositions/ComposicionAvanzada.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RenderOptionsBase {
  outputPath: string;
  workDir: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  onProgress?: (progress: number) => void;
}

export interface RenderPlanoFijoOptions extends RenderOptionsBase {
  composition: 'PlanoFijo';
  inputProps: PlanoFijoProps;
}

export interface RenderPlanoAnimadoOptions extends RenderOptionsBase {
  composition: 'PlanoAnimado';
  inputProps: PlanoAnimadoProps;
}

export interface RenderPlanoEscenasOptions extends RenderOptionsBase {
  composition: 'PlanoEscenas';
  inputProps: PlanoEscenasProps;
}

export interface RenderComposicionAvanzadaOptions extends RenderOptionsBase {
  composition: 'ComposicionAvanzada';
  inputProps: ComposicionAvanzadaProps;
}

export type RenderOptions =
  | RenderPlanoFijoOptions
  | RenderPlanoAnimadoOptions
  | RenderPlanoEscenasOptions
  | RenderComposicionAvanzadaOptions;

export interface RenderResult {
  outputPath: string;
  sizeBytes: number;
  durationSeconds: number;
}

// Bundle del proyecto Remotion + render del composition elegido (PlanoFijo o PlanoAnimado).
// publicDir = workDir → staticFile('audio.mp3') sirve desde el workDir del run.
export async function renderComposition(options: RenderOptions): Promise<RenderResult> {
  const entryPoint = resolve(__dirname, 'compositions/Root.tsx');

  const bundleLocation = await bundle({
    entryPoint,
    publicDir: options.workDir,
    webpackOverride: (config) => {
      config.resolve = config.resolve ?? {};
      config.resolve.extensionAlias = {
        ...(config.resolve.extensionAlias ?? {}),
        '.js': ['.js', '.tsx', '.ts'],
      };
      return config;
    },
  });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: options.composition,
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

// Backward-compat: la API anterior renderPlanoFijo sigue existiendo y delega al renderComposition.
export async function renderPlanoFijo(
  options: Omit<RenderPlanoFijoOptions, 'composition'>,
): Promise<RenderResult> {
  return renderComposition({ ...options, composition: 'PlanoFijo' });
}
