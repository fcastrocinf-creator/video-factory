// Arreglo lipsync: usa la VOZ NATIVA de cada clip (no TTS superpuesto).
// Mide la duración de cada clip + concatena el AUDIO PROPIO de los clips → combined-native.mp3
// + escribe manifest-sc20.json con las duraciones reales (para los cortes exactos).
// Uso: npx tsx scripts/prep-sc20.ts
import { spawn } from 'node:child_process';
import { writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';
const WORK = resolve(ROOT, 'storage/proto-sc20');
const PC = resolve(ROOT, 'storage/proto-composite');
const CLIPS = ['medico-hook.mp4', 'rosa.mp4', 'medico-explain.mp4'];

function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let err = '';
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (c: Buffer) => (err += c.toString('utf-8')));
    p.on('error', reject);
    p.on('close', () => resolveFn(err));
  });
}
async function dur(ffmpeg: string, file: string): Promise<number> {
  const out = await run(ffmpeg, ['-i', file, '-f', 'null', 'NUL']);
  const m = out.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  return m ? +m[1]! * 3600 + +m[2]! * 60 + +m[3]! : 0;
}

async function main(): Promise<void> {
  const ffmpeg = findFfmpegPath();
  copyFileSync(resolve(PC, 'rosa-hinchada.png'), resolve(WORK, 'rosa-hinchada.png'));
  const durs: number[] = [];
  for (const c of CLIPS) durs.push(await dur(ffmpeg, resolve(WORK, c)));
  // Concat del AUDIO NATIVO de los 3 clips (lipsync correcto, sincronizado a sí mismo).
  await run(ffmpeg, [
    '-y',
    '-i', resolve(WORK, CLIPS[0]!),
    '-i', resolve(WORK, CLIPS[1]!),
    '-i', resolve(WORK, CLIPS[2]!),
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'libmp3lame', resolve(WORK, 'combined-native.mp3'),
  ]);
  const [h, r, e] = durs as [number, number, number];
  writeFileSync(
    resolve(WORK, 'manifest-sc20.json'),
    JSON.stringify({ hookDur: +h.toFixed(3), rosaDur: +r.toFixed(3), explainDur: +e.toFixed(3), total: +(h + r + e).toFixed(3) }, null, 2),
  );
  console.log(`durs: hook=${h.toFixed(2)} rosa=${r.toFixed(2)} explain=${e.toFixed(2)} total=${(h + r + e).toFixed(2)}`);
}
void main();
