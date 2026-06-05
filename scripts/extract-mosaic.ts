// Extrae un MOSAICO denso de frames (grid) para inspección visual rápida de un video.
// Uso: pnpm tsx scripts/extract-mosaic.ts <video.mp4> <salida.png> [fps] [tile]
import { spawn } from 'node:child_process';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

const video = process.argv[2]!;
const out = process.argv[3]!;
const fps = process.argv[4] ?? '1.2';
const tile = process.argv[5] ?? '4x5';
const ffmpeg = findFfmpegPath();
const p = spawn(
  ffmpeg,
  ['-y', '-i', video, '-vf', `fps=${fps},scale=280:-1,tile=${tile}`, '-frames:v', '1', out],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
p.on('error', (e) => { console.error(e); process.exit(1); });
p.on('close', () => console.log(`OK → ${out}`));
