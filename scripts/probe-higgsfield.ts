// Probe rápido: 1 imagen con Higgsfield para verificar auth y endpoint
// antes de gastar 27 calls del smoke completo.

import { writeFile } from 'node:fs/promises';
import { HiggsfieldImageProvider } from '@video-factory/block-image-gen-imagen';

async function main() {
  const keyId = process.env['HIGGSFIELD_KEY_ID']!;
  const keySecret = process.env['HIGGSFIELD_KEY_SECRET']!;
  if (!keyId || !keySecret) {
    console.error('Faltan HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET en env');
    process.exit(1);
  }

  const provider = new HiggsfieldImageProvider({ keyId, keySecret });
  console.log('[probe] testing Higgsfield Flux Pro Kontext Max...');
  const start = Date.now();
  try {
    const buf = await provider.generate({
      prompt:
        'Hand-illustrated digital painting in warm sepia-watercolor style, a single ripe apple resting on a wooden table, soft morning light through a window, painterly brush strokes, vertical 9:16',
      aspectRatio: '9:16',
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    await writeFile('/tmp/higgsfield-probe.png', buf).catch(() => {});
    console.log(`[probe] OK — ${buf.length} bytes in ${elapsed}s`);
  } catch (e) {
    console.error('[probe] FAILED:', (e as Error).message.slice(0, 500));
    process.exit(1);
  }
}

main();
