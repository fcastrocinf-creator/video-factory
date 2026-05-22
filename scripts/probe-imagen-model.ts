// Probe rápido: una sola llamada a Imagen con el modelo especificado.
// Útil para verificar quota / disponibilidad sin gastar 27 calls.
import { ImagenClient } from '@video-factory/block-image-gen-imagen';
import { writeFile } from 'node:fs/promises';

async function main() {
  const model = process.argv[2] ?? 'imagen-3.0-generate-002';
  const apiKey = process.env['GOOGLE_AI_API_KEY']!;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY missing');
  const client = new ImagenClient({ apiKey });
  console.log(`[probe] testing model: ${model}`);
  try {
    const buf = await client.generate({
      prompt: 'A simple watercolor illustration of a single apple on a wooden table, vertical 9:16',
      aspectRatio: '9:16',
      sampleCount: 1,
      safetyFilterLevel: 'block_some',
      personGeneration: 'allow_adult',
      model,
    });
    await writeFile(`/tmp/probe_${model}.png`, buf).catch(() => {});
    console.log(`[probe] OK — ${buf.length} bytes`);
  } catch (e) {
    console.log(`[probe] FAILED:`, (e as Error).message.slice(0, 500));
    process.exit(1);
  }
}

main();
