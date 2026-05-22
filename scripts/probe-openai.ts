// Probe rápido de OpenAI gpt-image-1 — valida la API key antes del smoke completo.
import { writeFile } from 'node:fs/promises';
import { OpenaiImageProvider } from '@video-factory/block-image-gen-imagen';

async function main() {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey || apiKey === 'sk_pendiente') {
    console.error('[probe] OPENAI_API_KEY no seteada o placeholder.');
    console.error('  1. Generá una key en https://platform.openai.com/api-keys');
    console.error('  2. Agregá ~$10 USD de crédito en https://platform.openai.com/account/billing');
    console.error('  3. Reemplazá OPENAI_API_KEY=sk_pendiente en .env por la key real');
    process.exit(1);
  }

  const provider = new OpenaiImageProvider({ apiKey, quality: 'medium' });
  console.log('[probe] OpenAI gpt-image-1 medium quality, 1024x1536...');
  const start = Date.now();
  try {
    const buf = await provider.generate({
      prompt:
        'Hand-illustrated digital painting in warm sepia-watercolor style, a single ripe apple on a wooden table, soft morning light, painterly brush strokes, vertical 9:16',
      aspectRatio: '9:16',
      model: 'gpt-image-1',
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    await writeFile('storage/probe-openai.png', buf).catch(() => {});
    console.log(`[probe] OK — ${buf.length} bytes in ${elapsed}s → storage/probe-openai.png`);
  } catch (e) {
    console.error('[probe] FAILED:', (e as Error).message.slice(0, 600));
    process.exit(1);
  }
}
main();
