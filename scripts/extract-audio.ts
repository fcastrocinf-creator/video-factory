// Extrae el audio de un video a mp3 (para transcribir/verificar oyendo).
// Uso: pnpm tsx scripts/extract-audio.ts <video.mp4> <salida.mp3>
import { spawn } from 'node:child_process';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

const video = process.argv[2]!;
const out = process.argv[3]!;
const ffmpeg = findFfmpegPath();
const p = spawn(ffmpeg, ['-y', '-i', video, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', out], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
p.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
p.on('close', () => console.log(`OK → ${out}`));
