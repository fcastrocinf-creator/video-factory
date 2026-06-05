// Prep del TRAMO CLAVE — LIPSYNC CORRECTO: usa el AUDIO NATIVO de cada clip de Higgsfield
// (sus labios calzan con su propio audio), NO un TTS superpuesto. Concatena:
//   [médico-hook VOZ EN OFF corregida] + [médico-zonas voz en off] + [médico-después voz en off]
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
    [resolve(PC, 'estado1_hinchada.png'), 'estado1_hinchada.png'], // ANTES (misma mujer, editada)
    [resolve(PC, 'estado2_media.png'), 'estado2_media.png'],       // INTERMEDIO (va mejorando)
    [resolve(PC, 'estado3_renovada.png'), 'estado3_renovada.png'], // DESPUÉS (renovada)
    [resolve(PC, 'producto.png'), 'producto.png'],
    [resolve(PC, 'packshot.jpg'), 'packshot.jpg'], // PRODUCTO real (packshot de marca, marca legible)
    [resolve(PC, 'medico-ugc.png'), 'medico-ugc.png'], // CARA del médico (hook foto + PiP), UGC real en consultorio
  ] as [string, string][]) {
    if (existsSync(from)) copyFileSync(from, resolve(WORK, to));
    else console.log(`AVISO: falta ${from}`);
  }
  // VOZ NATIVA del clip (regla del owner): la voz del médico sale del MISMO modelo que
  // genera el video (Veo 3.1 genera voz + labios JUNTOS = lipsync real). El HOOK usa el
  // AUDIO NATIVO del clip Veo (medico-hook-veo.mp4) — NUNCA un TTS de ElevenLabs encima
  // (eso patina/desfasa). Las voces zonas/después siguen como voz en off del médico
  // (van sobre fotos de Rosa, sin su cara → no hay lipsync que romper).
  // VOZ NATIVA del médico de PUNTA A PUNTA (regla del owner): 2 clips Veo del médico —
  // hook ("Sientes la cara hinchada...") + off ("Aquí observamos ojeras y papada... en
  // pocas semanas más firme"). Ambas voces salen del MISMO modelo (Veo) → consistentes y
  // con lipsync. Ya NO se usan los TTS de ElevenLabs (medico-zonas/medico-despues).
  const hookClip = resolve(WORK, 'medico-hook-veo.mp4');
  const offClip = resolve(WORK, 'medico-off-veo.mp4');
  const [hookDur, offDur] = await Promise.all([
    dur(ffmpeg, hookClip), dur(ffmpeg, offClip),
  ]);
  // Pista de audio = audio nativo del hook clip ([0:a]) + audio nativo del off clip ([1:a]).
  await run(ffmpeg, [
    '-y', '-i', hookClip, '-i', offClip,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'libmp3lame', resolve(WORK, 'combined-key.mp3'),
  ]);
  writeFileSync(
    resolve(WORK, 'manifest-key.json'),
    JSON.stringify({ hookDur: +hookDur.toFixed(3), offDur: +offDur.toFixed(3) }, null, 2),
  );
  console.log(`OK proto-key (voz nativa Veo, hook+off) · hook=${hookDur.toFixed(2)} off=${offDur.toFixed(2)}`);
}
void main();
