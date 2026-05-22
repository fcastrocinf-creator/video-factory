// Test del text-overlay rendering en Remotion — usa las 27 imágenes del run
// premium-acdf6c97 (ya generadas), inyecta textOverlays sintéticos en escenas
// estratégicas, y re-renderiza el video. Verifica que las capas vectoriales se
// vean correctas sin necesitar nuevas llamadas a Imagen.

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type RenderJob,
  type Scene,
  type SceneTrack,
  type SubtitleTrack,
  type TextOverlay,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SOURCE_RUN_ID = 'premium-acdf6c97';
const SOURCE_DIR = resolve(REPO_ROOT, 'storage', 'runs', SOURCE_RUN_ID);

async function main() {
  const runId = `overlay-test-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  // Copiamos audio + imágenes del run anterior al nuevo workDir.
  if (!existsSync(resolve(SOURCE_DIR, 'audio.mp3'))) {
    throw new Error(`Falta audio en ${SOURCE_DIR}`);
  }
  await copyFile(resolve(SOURCE_DIR, 'audio.mp3'), resolve(workDir, 'audio.mp3'));
  for (let i = 0; i < 27; i++) {
    const src = resolve(SOURCE_DIR, `scene_${String(i).padStart(2, '0')}.png`);
    const dst = resolve(workDir, `scene_${String(i).padStart(2, '0')}.png`);
    if (existsSync(src)) await copyFile(src, dst);
  }
  // eslint-disable-next-line no-console
  console.log(`[overlay-test] workDir=${workDir}`);

  // Cargamos plan + subtitles del run original.
  const planRaw = JSON.parse(await readFile(resolve(SOURCE_DIR, 'scene-plan.json'), 'utf-8')) as SceneTrack;
  const subsRaw = JSON.parse(await readFile(resolve(SOURCE_DIR, 'subtitles.debug.json'), 'utf-8')) as SubtitleTrack;

  // Inyectamos textOverlays sintéticos en escenas estratégicas:
  // - scene_22 (producto): product-label "VITALY GOTAS"
  // - scene_25 (calendar 30 días): day-counter "DÍA 30"
  // - scene_24 (2 goteros): metric-callout "2 GOTEROS"
  const overlayInjections: Array<{ index: number; overlays: TextOverlay[] }> = [
    {
      index: 22,
      overlays: [{ kind: 'product-label', text: 'VITALY GOTAS', position: 'bottom', scale: 0.9 }],
    },
    {
      index: 25,
      overlays: [{ kind: 'day-counter', text: 'DÍA 30', position: 'top-right', scale: 1.0 }],
    },
    {
      index: 24,
      overlays: [{ kind: 'metric-callout', text: '2 GOTEROS', position: 'center', scale: 0.85 }],
    },
  ];

  const enrichedScenes: Scene[] = planRaw.scenes.map((s) => {
    const injection = overlayInjections.find((o) => o.index === s.index);
    return injection ? { ...s, textOverlays: injection.overlays } : s;
  });

  const enrichedTrack: SceneTrack = { ...planRaw, scenes: enrichedScenes };

  // Guardamos el plan enriquecido a disco.
  await writeFile(resolve(workDir, 'scene-plan.json'), JSON.stringify(enrichedTrack, null, 2));

  // Load brand + preset
  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/presets/educativo_premium.preset.json'), 'utf-8')),
  );

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  const audioPath = resolve(workDir, 'audio.mp3');
  const outputPath = resolve(workDir, 'final.mp4');

  // RenderJob mínimo
  const renderJob: RenderJob = {
    runId,
    brandId: brand.id,
    presetId: preset.id,
    parsedScript: {
      language: 'es',
      segments: [],
      estimatedDurationSeconds: enrichedTrack.totalDurationSeconds,
    },
    audioTrack: {
      filePath: audioPath,
      durationSeconds: enrichedTrack.totalDurationSeconds,
      sampleRate: 44100,
      channels: 1,
      format: 'mp3',
      segments: [],
    },
    subtitleTrack: subsRaw,
    imagePath: resolve(workDir, basename(enrichedScenes[0]?.imagePath ?? 'scene_00.png')),
    sceneTrack: {
      ...enrichedTrack,
      scenes: enrichedScenes.map((s) => ({
        ...s,
        imagePath: resolve(workDir, `scene_${String(s.index).padStart(2, '0')}.png`),
      })),
    },
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };

  // eslint-disable-next-line no-console
  console.log('[overlay-test] empezando render...');
  const result = await compositorRemotion.run(renderJob, ctx);
  if (result.isErr()) {
    // eslint-disable-next-line no-console
    console.error('[overlay-test] FAILED', result.error);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[overlay-test] OK — ${outputPath}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FAILED', e);
  process.exit(1);
});
