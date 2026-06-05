// Extrae frames clave de un mp4 para verificar VIENDO (hook, Rosa+PiP, después, producto).
// Uso: pnpm tsx scripts/extract-frames-key11.ts <video.mp4> <prefijo-salida>
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';

function run(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', rej);
    p.on('close', () => res());
  });
}

async function main(): Promise<void> {
  const video = process.argv[2] ?? resolve(ROOT, 'storage/proto-composite/supercalm-key11.mp4');
  const prefix = process.argv[3] ?? resolve(ROOT, 'storage/proto-composite/k11');
  const ffmpeg = findFfmpegPath();
  const shots: [string, number][] = [
    ['hook', 5],        // médico (foto) — el hook
    ['antes-pip', 12.5],// Rosa hinchada + círculos + médico en PiP
    ['despues-pip', 19],// Rosa renovada + médico en PiP
    ['producto', 22.5], // packshot final
  ];
  for (const [name, t] of shots) {
    const out = `${prefix}-${name}.png`;
    await run(ffmpeg, ['-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-q:v', '2', out]);
    console.log(`OK ${name} @${t}s → ${out}`);
  }
}
void main();
