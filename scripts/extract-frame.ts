// Extrae 1 frame de un video con el ffmpeg de Remotion. Verificación visual.
// Uso: npx tsx scripts/extract-frame.ts <video> <segundos> <out.png>
import { spawn } from 'node:child_process';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

const video = process.argv[2]!;
const t = process.argv[3] ?? '1';
const out = process.argv[4]!;
const ffmpeg = findFfmpegPath();
const p = spawn(ffmpeg, ['-y', '-ss', t, '-i', video, '-frames:v', '1', out], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
p.on('close', (c) => console.log(`exit ${c} → ${out}`));
