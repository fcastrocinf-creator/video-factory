// Probe rápido de Kling image-to-video. Usa una imagen ya generada y mide tiempo.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { KlingClient } from '@video-factory/block-video-gen-veo';

async function main() {
  const accessKey = process.env['KLING_ACCESS_KEY'];
  const secretKey = process.env['KLING_SECRET_KEY'];
  if (!accessKey || !secretKey) {
    console.error('KLING_ACCESS_KEY / KLING_SECRET_KEY no seteadas');
    process.exit(1);
  }

  // Buscamos una imagen del último smoke largo
  const candidates = [
    'storage/runs/animado-largo-1d425c8e/scene_00.png',
    'storage/runs/animado-sepia-765176bf/scene_00.png',
    'storage/runs/animado-sepia-397499de/scene_00.png',
  ];
  const sourceImage = candidates.find((p) => existsSync(resolve(p)));
  if (!sourceImage) {
    console.error('No encontré ninguna imagen de prueba');
    process.exit(1);
  }
  const imageBuffer = await readFile(resolve(sourceImage));
  console.log(`[probe-kling] imagen: ${sourceImage} (${imageBuffer.length} bytes)`);

  const client = new KlingClient({ accessKey, secretKey });
  console.log('[probe-kling] enviando a kling-v2-6 std 5s 9:16...');
  const start = Date.now();
  try {
    const videoBuffer = await client.generate({
      prompt:
        'Subtle natural movement: character breathes and blinks, very gentle camera push-in, same composition, watercolor sepia style maintained, no scene changes.',
      imageBase64: imageBuffer.toString('base64'),
      model: 'kling-v2-6',
      mode: 'std',
      duration: '5',
      onProgress: (msg) => console.log(`[probe-kling] status: ${msg}`),
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const outPath = 'storage/probe-kling.mp4';
    await writeFile(outPath, videoBuffer);
    console.log(`[probe-kling] OK — ${videoBuffer.length} bytes in ${elapsed}s → ${outPath}`);
  } catch (e) {
    console.error('[probe-kling] FAILED:', (e as Error).message.slice(0, 1500));
    process.exit(1);
  }
}
main();
