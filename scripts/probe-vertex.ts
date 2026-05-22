// Probe rápido de Vertex AI Imagen
import { writeFile } from 'node:fs/promises';
import { VertexImagenProvider } from '@video-factory/block-image-gen-imagen';

async function main() {
  const provider = new VertexImagenProvider({});
  console.log('[probe] Vertex AI Imagen Fast...');
  const start = Date.now();
  try {
    const buf = await provider.generate({
      prompt:
        'Hand-illustrated digital painting in warm sepia-watercolor style, a single ripe apple on a wooden table, soft morning light, painterly brush strokes, vertical 9:16',
      aspectRatio: '9:16',
      model: 'imagen-4.0-fast-generate-001',
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    await writeFile('/tmp/vertex-probe.png', buf).catch(() => {});
    console.log(`[probe] OK — ${buf.length} bytes in ${elapsed}s`);
  } catch (e) {
    console.error('[probe] FAILED:', (e as Error).message.slice(0, 600));
    process.exit(1);
  }
}
main();
