// Extrae frames de un video en tiempos dados (para verificar movimiento/lipsync).
// Uso: pnpm tsx scripts/extract-frames-at.ts <video.mp4> <prefijo> <t1,t2,t3,...>
import { spawn } from 'node:child_process';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

function run(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', rej);
    p.on('close', () => res());
  });
}

async function main(): Promise<void> {
  const video = process.argv[2]!;
  const prefix = process.argv[3]!;
  const times = (process.argv[4] ?? '1,4,7,10').split(',').map((s) => s.trim());
  const ffmpeg = findFfmpegPath();
  for (const t of times) {
    const out = `${prefix}-${t}s.png`;
    await run(ffmpeg, ['-y', '-ss', t, '-i', video, '-frames:v', '1', '-q:v', '2', out]);
    console.log(`OK @${t}s → ${out}`);
  }
}
void main();
