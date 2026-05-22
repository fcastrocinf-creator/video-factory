// Probe rápido SOLO de Vertex Veo image-to-video. Reusa una imagen ya generada
// en algún run previo. Itera en ~60-90s en lugar de los 5 min del smoke completo.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { VeoClient } from '@video-factory/block-video-gen-veo';

async function main() {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) {
    console.error('GOOGLE_AI_API_KEY no seteada');
    process.exit(1);
  }

  // Usamos la primera imagen del último smoke
  const sourceImage = resolve(
    'storage',
    'runs',
    'animado-sepia-765176bf',
    'scene_00.png',
  );
  if (!existsSync(sourceImage)) {
    console.error(`No existe ${sourceImage}`);
    process.exit(1);
  }
  const imageBuffer = await readFile(sourceImage);
  console.log(`[probe] imagen: ${sourceImage} (${imageBuffer.length} bytes)`);

  const client = new VeoClient({ apiKey });
  console.log('[probe] Vertex Veo image-to-video, 8s, 9:16, veo-3.0-fast-generate-001 (vía mapping)...');
  const start = Date.now();
  try {
    const videoBuffer = await client.generate({
      prompt:
        'Subtle natural movement: character breathes and blinks, very gentle 5% camera push-in, same composition, no scene changes, watercolor sepia style maintained.',
      imageBase64: imageBuffer.toString('base64'),
      imageMimeType: 'image/png',
      aspectRatio: '9:16',
      durationSeconds: 8,
      model: 'veo-3.1-lite-generate-preview', // se mapea a veo-3.0-fast-generate-001 en Vertex
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const outPath = 'storage/probe-vertex-veo.mp4';
    await writeFile(outPath, videoBuffer);
    console.log(`[probe] OK — ${videoBuffer.length} bytes in ${elapsed}s → ${outPath}`);
  } catch (e) {
    console.error('[probe] FAILED:', (e as Error).message.slice(0, 1500));
    process.exit(1);
  }
}
main();
