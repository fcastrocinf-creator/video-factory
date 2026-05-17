import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type AudioTrack,
  type RenderJob,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

// PNG placeholder amarillo (Vitaly brand color #FFE600) 100×100. Suficiente como
// stand-in para Imagen 4 hasta que la API key esté bien restringida.
// Generado con encoder PNG inline (sin deps externas).
function makeYellowPlaceholderPng(): Buffer {
  const width = 100;
  const height = 100;
  const r = 0xff;
  const g = 0xe6;
  const b = 0x00;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = 1 + 3 * width;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < width; x++) {
      const off = y * rowSize + 1 + 3 * x;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }

  const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
  const idatData = deflateSync(raw);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function main() {
  const runId = `smoke-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brandJson = await readFile(
    resolve(REPO_ROOT, 'packages', 'brands', 'vitaly.brand.json'),
    'utf-8',
  );
  const presetJson = await readFile(
    resolve(REPO_ROOT, 'packages', 'presets', 'educativo_pixar.preset.json'),
    'utf-8',
  );
  const brand = BrandConfigSchema.parse(JSON.parse(brandJson));
  const preset = PresetConfigSchema.parse(JSON.parse(presetJson));

  // Reusar audio existente de run anterior (no quema quota de ElevenLabs).
  const sourceAudio = resolve(
    REPO_ROOT,
    'storage',
    'runs',
    '35d33de4-9071-4ec6-96a9-c53f7769a55c',
    'audio.mp3',
  );
  if (!existsSync(sourceAudio)) {
    throw new Error(`No existe el audio fuente: ${sourceAudio}`);
  }
  const audioPath = resolve(workDir, 'audio.mp3');
  await writeFile(audioPath, await readFile(sourceAudio));
  // eslint-disable-next-line no-console
  console.log(`[smoke] audio copiado: ${audioPath}`);

  // Imagen placeholder (skip B.4 mientras Imagen API esté bloqueada).
  const imagePath = resolve(workDir, 'image.png');
  await writeFile(imagePath, makeYellowPlaceholderPng());
  // eslint-disable-next-line no-console
  console.log(`[smoke] imagen placeholder: ${imagePath}`);

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  // B.1 — script-processor (síncrono, sin API)
  const scriptInputResult = scriptProcessor.validateInput({
    rawText: TEST_SCRIPT,
    language: brand.language.split('-')[0] ?? 'es',
  });
  if (scriptInputResult.isErr()) throw scriptInputResult.error;
  const parsedResult = await scriptProcessor.run(scriptInputResult.value, ctx);
  if (parsedResult.isErr()) throw parsedResult.error;
  const parsedScript = parsedResult.value;
  // eslint-disable-next-line no-console
  console.log(`[smoke] B.1 OK: ${parsedScript.segments.length} segmentos`);

  // AudioTrack sintético apuntando al mp3 existente (skip B.2).
  const audioTrack: AudioTrack = {
    filePath: audioPath,
    durationSeconds: parsedScript.estimatedDurationSeconds,
    sampleRate: 44100,
    channels: 1,
    format: 'mp3',
    segments: parsedScript.segments.map((s, i, arr) => ({
      text: s.text,
      startTimeSeconds: (i * parsedScript.estimatedDurationSeconds) / arr.length,
      endTimeSeconds: ((i + 1) * parsedScript.estimatedDurationSeconds) / arr.length,
    })),
  };

  // B.3 — subtitles-google (consume Speech API)
  const subsResult = await subtitlesGoogle.run(audioTrack, ctx);
  if (subsResult.isErr()) throw subsResult.error;
  const subtitleTrack = subsResult.value;
  // eslint-disable-next-line no-console
  console.log(
    `[smoke] B.3 OK: ${subtitleTrack.words.length} palabras, ${subtitleTrack.lines.length} líneas`,
  );

  // B.5 — compositor-remotion (descarga Chromium primera vez, ~150 MB)
  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId,
    brandId: brand.id,
    presetId: preset.id,
    parsedScript,
    audioTrack,
    subtitleTrack,
    imagePath,
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };
  const renderResult = await compositorRemotion.run(renderJob, ctx);
  if (renderResult.isErr()) throw renderResult.error;
  // eslint-disable-next-line no-console
  console.log(`[smoke] B.5 OK: ${outputPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
