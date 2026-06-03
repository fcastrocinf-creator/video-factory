// Prepara los assets del demo de validación SuperCalm a partir de medico.mp4 (HeyGen):
//   1) extrae la voz del médico (audio) → medico.m4a (o .wav fallback)
//   2) recorta el fondo verde del médico → medico_cut.webm (alpha)
//   3) copia rosa-dia1.png al workDir
//   4) escribe manifest.json {durationSec, fps, audioFile}
// Uso: npx tsx scripts/prep-supercalm-assets.ts
import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findFfmpegPath } from '../apps/web/lib/ffmpeg-locator';
import { prepareVideoCutout } from '../apps/web/lib/video-cutout';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';
const PC = resolve(ROOT, 'storage/proto-composite');
const WORK = resolve(ROOT, 'storage/proto-supercalm');
// Acepta un clip de entrada por argumento (ej. el de Kling); por defecto medico.mp4.
const MEDICO_MP4 = process.argv[2] ? resolve(process.argv[2]) : resolve(PC, 'medico.mp4');

function ff(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolveFn, reject) => {
    let err = '';
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (c: Buffer) => (err += c.toString('utf-8')));
    p.on('error', (e) => reject(e));
    p.on('close', (code) => (code === 0 ? resolveFn() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`))));
  });
}

async function extractAudio(ffmpeg: string): Promise<string> {
  // Intenta copy AAC → m4a (sin re-encode); si falla, wav pcm; si falla, mp3.
  const tries: Array<{ file: string; args: string[] }> = [
    { file: 'medico.m4a', args: ['-y', '-i', MEDICO_MP4, '-vn', '-c:a', 'copy', resolve(WORK, 'medico.m4a')] },
    { file: 'medico.wav', args: ['-y', '-i', MEDICO_MP4, '-vn', '-c:a', 'pcm_s16le', resolve(WORK, 'medico.wav')] },
    { file: 'medico.mp3', args: ['-y', '-i', MEDICO_MP4, '-vn', '-c:a', 'libmp3lame', resolve(WORK, 'medico.mp3')] },
  ];
  for (const t of tries) {
    try {
      await ff(ffmpeg, t.args);
      console.log(`   audio OK → ${t.file}`);
      return t.file;
    } catch (e) {
      console.log(`   audio ${t.file} falló: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  throw new Error('no se pudo extraer audio con ningún codec');
}

async function main(): Promise<void> {
  if (!existsSync(MEDICO_MP4)) throw new Error(`falta ${MEDICO_MP4}`);
  mkdirSync(WORK, { recursive: true });
  const ffmpeg = findFfmpegPath();
  console.log('ffmpeg:', ffmpeg);

  console.log('1) extrayendo audio del médico...');
  const audioFile = await extractAudio(ffmpeg);

  console.log('2) recortando fondo verde del médico → webm alpha...');
  const cut = await prepareVideoCutout({
    inputVideoPath: MEDICO_MP4,
    outputWebmPath: resolve(WORK, 'medico_cut.webm'),
  });
  const durationSec = +(cut.frameCount / cut.fps).toFixed(3);

  console.log('3) copiando rosa-dia1.png...');
  copyFileSync(resolve(PC, 'rosa-dia1.png'), resolve(WORK, 'rosa-dia1.png'));

  writeFileSync(
    resolve(WORK, 'manifest.json'),
    JSON.stringify({ durationSec, fps: cut.fps, frameCount: cut.frameCount, audioFile }, null, 2),
  );
  console.log(`OK → ${WORK}  ·  dur=${durationSec}s  fps=${cut.fps}  frames=${cut.frameCount}  audio=${audioFile}`);
}
void main();
