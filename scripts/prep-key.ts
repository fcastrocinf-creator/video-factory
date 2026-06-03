// Prep del TRAMO CLAVE — LIPSYNC CORRECTO: usa el AUDIO NATIVO de cada clip de Higgsfield
// (sus labios calzan con su propio audio), NO un TTS superpuesto. Concatena:
//   [audio nativo médico-hook] + [médico-zonas voz en off] + [audio nativo Rosa-después]
// + copia assets + manifest-key.json con las duraciones REALES de los clips.
// Uso: npx tsx scripts/prep-key.ts
import { spawn } from 'node:child_process';
import { writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';
const SC = resolve(ROOT, 'storage/proto-sc20');
const PC = resolve(ROOT, 'storage/proto-composite');
const WORK = resolve(ROOT, 'storage/proto-key');

function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let err = '';
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (c: Buffer) => (err += c.toString('utf-8')));
    p.on('error', reject);
    p.on('close', () => resolveFn(err));
  });
}
async function dur(ffmpeg: string, f: string): Promise<number> {
  const o = await run(ffmpeg, ['-i', f, '-f', 'null', 'NUL']);
  const m = o.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  return m ? +m[1]! * 3600 + +m[2]! * 60 + +m[3]! : 0;
}

async function main(): Promise<void> {
  const ffmpeg = findFfmpegPath();
  mkdirSync(WORK, { recursive: true });
  for (const [from, to] of [
    [resolve(SC, 'medico-hook.mp4'), 'medico-hook.mp4'],
    [resolve(PC, 'rosa-final.png'), 'rosa-final.png'], // foto "después" realista (soul_2 recortada)
    [resolve(SC, 'medico-zonas.mp3'), 'medico-zonas.mp3'],
    [resolve(SC, 'medico-despues.mp3'), 'medico-despues.mp3'], // voz en off del médico (después)
    [resolve(PC, 'rosa-hinchada.png'), 'rosa-hinchada.png'],
    [resolve(PC, 'producto.png'), 'producto.png'],
  ] as [string, string][]) {
    if (existsSync(from)) copyFileSync(from, resolve(WORK, to));
    else console.log(`AVISO: falta ${from}`);
  }
  const hookClip = resolve(WORK, 'medico-hook.mp4');
  const zonas = resolve(WORK, 'medico-zonas.mp3');
  const despuesVo = resolve(WORK, 'medico-despues.mp3');
  // hookDur = duración del clip del médico (voz nativa en cámara). La escena "después" es
  // una FOTO fija → dura lo que la voz en off del médico + un respiro.
  const [hookDur, zonasDur, despuesVoDur] = await Promise.all([
    dur(ffmpeg, hookClip), dur(ffmpeg, zonas), dur(ffmpeg, despuesVo),
  ]);
  const despuesDur = +(despuesVoDur + 0.6).toFixed(3);
  // Pista de audio = SIEMPRE el médico: su voz NATIVA en cámara (hook) + 2 voces en off
  // (zonas sobre Rosa-antes, después sobre el b-roll de Rosa). Rosa NUNCA habla → sin lipsync.
  await run(ffmpeg, [
    '-y', '-i', hookClip, '-i', zonas, '-i', despuesVo,
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'libmp3lame', resolve(WORK, 'combined-key.mp3'),
  ]);
  writeFileSync(
    resolve(WORK, 'manifest-key.json'),
    JSON.stringify({ hookDur: +hookDur.toFixed(3), zonasDur: +zonasDur.toFixed(3), despuesDur: +despuesDur.toFixed(3) }, null, 2),
  );
  console.log(`OK proto-key (audio nativo) · hook=${hookDur.toFixed(2)} zonas=${zonasDur.toFixed(2)} despues=${despuesDur.toFixed(2)}`);
}
void main();
