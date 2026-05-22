// Demo híbrida: re-genera el SceneTrack con scene-planner v3 (incluye
// textOverlays auto-detectados) pero reusa las 27 imágenes existentes del
// run premium-acdf6c97 (porque Imagen quota agotada). Renderiza con todos los
// validators + overlays.
//
// El usuario verá:
//   ✓ TextOverlay "VITALY GOTAS" sobre la escena del frasco
//   ✓ TextOverlay "DÍA 10" / "DÍA 30" sobre las escenas correspondientes
//   ✓ Render fresh con Remotion + audio + subtítulos
//   ✗ Las marcas infinity y otros bugs de Imagen siguen porque no regeneramos imgs
//     (el validator V3 las detecta pero sin Imagen no puede regenerarlas hoy)

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type AudioTrack,
  type RenderJob,
  type SubtitleTrack,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { narratorAnalyzer } from '@video-factory/block-narrator-analyzer';
import { ScenePlannerBlock } from '@video-factory/block-scene-planner';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SOURCE_RUN = 'premium-acdf6c97';
const SOURCE_DIR = resolve(REPO_ROOT, 'storage/runs', SOURCE_RUN);

const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

async function main() {
  const runId = `hybrid-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage/runs', runId);
  await mkdir(workDir, { recursive: true });

  // Copiamos audio + imágenes del SOURCE_RUN
  const audioPath = resolve(workDir, 'audio.mp3');
  await copyFile(resolve(SOURCE_DIR, 'audio.mp3'), audioPath);

  // Detectamos cuántas imágenes hay disponibles
  const sourceImages: string[] = [];
  for (let i = 0; i < 30; i++) {
    const src = resolve(SOURCE_DIR, `scene_${String(i).padStart(2, '0')}.png`);
    if (existsSync(src)) {
      const dst = resolve(workDir, `scene_${String(i).padStart(2, '0')}.png`);
      await copyFile(src, dst);
      sourceImages.push(dst);
    }
  }
  console.log(`[hybrid] workDir=${workDir} sourceImages=${sourceImages.length}`);

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/presets/educativo_premium.preset.json'), 'utf-8')),
  );
  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  // B.1 script-processor
  const sin = scriptProcessor.validateInput({ rawText: TEST_SCRIPT, language: 'es' });
  if (sin.isErr()) throw sin.error;
  const sp = await scriptProcessor.run(sin.value, ctx);
  if (sp.isErr()) throw sp.error;

  // B.1.5 narrator analyzer
  const narratorRes = await narratorAnalyzer.run(sp.value, ctx);
  if (narratorRes.isErr()) throw narratorRes.error;
  const parsedScript = narratorRes.value;
  console.log(`[hybrid] narrator: ${parsedScript.narratorProfile?.gender} / ${parsedScript.narratorProfile?.ageRange}`);

  // Audio cacheado + probe duración
  const FFPROBE = resolve(REPO_ROOT, 'node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.462/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe');
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
  const realDuration = parseFloat(probe.stdout.toString().trim());
  console.log(`[hybrid] audio duration=${realDuration.toFixed(2)}s`);

  const audioTrack: AudioTrack = {
    filePath: audioPath,
    durationSeconds: realDuration,
    sampleRate: 44100,
    channels: 1,
    format: 'mp3',
    segments: parsedScript.segments.map((s, i, arr) => ({
      text: s.text,
      startTimeSeconds: (i * realDuration) / arr.length,
      endTimeSeconds: ((i + 1) * realDuration) / arr.length,
    })),
  };

  // Reusamos subtitles del run anterior
  const subtitleTrack: SubtitleTrack = JSON.parse(
    await readFile(resolve(SOURCE_DIR, 'subtitles.debug.json'), 'utf-8'),
  );

  // B.4 scene-planner v3 (genera textOverlays auto-detectados — NO gasta Imagen)
  const planner = new ScenePlannerBlock({ targetSceneCount: sourceImages.length });
  const planRes = await planner.run({ parsedScript, subtitleTrack }, ctx);
  if (planRes.isErr()) throw planRes.error;
  const sceneTrack = planRes.value;
  console.log(`[hybrid] scene-planner OK: ${sceneTrack.scenes.length} escenas`);

  // Asignamos las imágenes existentes a las escenas nuevas en orden
  const scenesWithImages = sceneTrack.scenes.map((s, i) => ({
    ...s,
    imagePath: sourceImages[i] ?? sourceImages[sourceImages.length - 1]!,
  }));

  const enrichedTrack = { ...sceneTrack, scenes: scenesWithImages };
  await writeFile(resolve(workDir, 'scene-plan.json'), JSON.stringify(enrichedTrack, null, 2));

  // Log las escenas con textOverlays para que el usuario sepa cuáles llevan
  const overlayScenes = scenesWithImages.filter((s) => s.textOverlays && s.textOverlays.length > 0);
  console.log(`\n[hybrid] ${overlayScenes.length} escenas con textOverlays:`);
  for (const s of overlayScenes) {
    for (const o of s.textOverlays!) {
      console.log(`  [${s.index}] ${o.kind}: "${o.text}" @ ${o.position ?? 'default'} → "${s.text.slice(0, 50)}..."`);
    }
  }

  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId,
    brandId: brand.id,
    presetId: preset.id,
    parsedScript,
    audioTrack,
    subtitleTrack,
    imagePath: scenesWithImages[0]!.imagePath!,
    sceneTrack: enrichedTrack,
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };

  console.log('\n[hybrid] iniciando render Remotion...');
  const renderRes = await compositorRemotion.run(renderJob, ctx);
  if (renderRes.isErr()) throw renderRes.error;
  console.log(`[hybrid] DONE — ${outputPath}`);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
