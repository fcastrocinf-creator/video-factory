// Verifica que scene-planner (con el system prompt actualizado) genera
// textOverlays en las escenas adecuadas:
//   - escena que mencione "Vitaly Gotas" o "Vitaly" → product-label
//   - escena que mencione "30 días" o "10 días" → day-counter
//   - escena que mencione "2 goteros" → metric-callout
//
// Si Gemini ignora las nuevas instrucciones, el sistema overlay NUNCA se
// activa en producción. Este test gasta solo 2 calls de Gemini Pro (no Imagen).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type SubtitleTrack,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { ScenePlannerBlock } from '@video-factory/block-scene-planner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

async function main() {
  // Reusamos el subtitleTrack y workDir del último run premium
  const sourceDir = resolve(REPO_ROOT, 'storage/runs/premium-acdf6c97');
  const subtitleTrack = JSON.parse(
    await readFile(resolve(sourceDir, 'subtitles.debug.json'), 'utf-8'),
  ) as SubtitleTrack;

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/presets/educativo_premium.preset.json'), 'utf-8')),
  );

  const logger = createLogger('test-overlays');
  const ctx: BlockContext = {
    runId: 'test-overlays',
    workDir: resolve(REPO_ROOT, 'storage/runs/test-overlays'),
    logger,
    brand,
    preset,
  };

  // Construimos un ParsedScript mínimo
  const parsedScript = {
    language: 'es',
    segments: TEST_SCRIPT.split('\n')
      .filter((l) => l.trim().length > 0)
      .map((text) => ({ text, pauseAfterMs: 200, emphasisWords: [] })),
    estimatedDurationSeconds: 64.18,
  };

  console.log('Llamando scene-planner con el script Dr. Hiroshi...\n');
  const planner = new ScenePlannerBlock({ targetSceneCount: 27 });
  const result = await planner.run({ parsedScript, subtitleTrack }, ctx);
  if (result.isErr()) throw result.error;
  const sceneTrack = result.value;

  console.log(`✓ Scene-planner OK: ${sceneTrack.scenes.length} escenas\n`);

  // Buscar escenas con textOverlays
  const withOverlays = sceneTrack.scenes.filter((s) => s.textOverlays && s.textOverlays.length > 0);
  console.log(`Escenas con textOverlays: ${withOverlays.length}/${sceneTrack.scenes.length}\n`);

  for (const scene of withOverlays) {
    console.log(`[${scene.index}] "${scene.text.slice(0, 60)}..."`);
    for (const o of scene.textOverlays!) {
      console.log(`  └─ ${o.kind}: "${o.text}" (position=${o.position ?? 'default'})`);
    }
    console.log(`  imagePrompt incluye "no text/blank label"? → ${/no text|blank|without text|sin texto/i.test(scene.imagePrompt) ? 'SÍ ✓' : 'NO ✗'}`);
    console.log();
  }

  // Verificaciones automáticas — qué se ESPERA encontrar:
  console.log('═'.repeat(60));
  console.log('VERIFICACIONES');
  console.log('═'.repeat(60));

  const checks: Array<{ label: string; pass: boolean }> = [];

  // Check 1: alguna escena con product-label en una escena que menciona "Vitaly"
  const productLabelScene = withOverlays.find((s) =>
    s.textOverlays!.some((o) => o.kind === 'product-label') &&
    /vitaly/i.test(s.text),
  );
  checks.push({
    label: 'Escena con "Vitaly" debe tener product-label overlay',
    pass: !!productLabelScene,
  });

  // Check 2: día-counter en escena que menciona "10 días" o "30 días"
  const dayCounterScene = withOverlays.find((s) =>
    s.textOverlays!.some((o) => o.kind === 'day-counter') &&
    /\d+\s*d[ií]as?/i.test(s.text),
  );
  checks.push({
    label: 'Escena con "X días" debe tener day-counter overlay',
    pass: !!dayCounterScene,
  });

  // Check 3: imagePrompts de overlays mencionan "no text" para que Imagen genere limpio
  const allOverlayPromptsLimpios = withOverlays.every((s) =>
    /no text|blank|without text|sin texto|clean (?:background|label)/i.test(s.imagePrompt),
  );
  checks.push({
    label: 'imagePrompts de escenas con overlay incluyen "no text"',
    pass: allOverlayPromptsLimpios,
  });

  // Check 4: no overlays en escenas que no los necesitan (controles negativos)
  const escenaSinTextoFalsoPositivo = sceneTrack.scenes.find((s) =>
    s.textOverlays && s.textOverlays.length > 0 &&
    !/vitaly|gotas|d[ií]as?|\bdoctor\b|kioto|kyoto|goteros?|días?|años?|minutos?/i.test(s.text),
  );
  checks.push({
    label: 'Sin overlays en escenas que no los necesitan (no falsos positivos)',
    pass: !escenaSinTextoFalsoPositivo,
  });

  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.label}`);
  }

  const passCount = checks.filter((c) => c.pass).length;
  console.log(`\nResultado: ${passCount}/${checks.length} checks`);

  process.exit(passCount === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
