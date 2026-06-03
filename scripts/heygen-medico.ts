// Genera el clip del MÉDICO con lipsync (HeyGen) desde la foto generada (verde).
// Uso: npx tsx scripts/heygen-medico.ts
// Sube la foto → talking_photo, elige voz ES masculina, genera, descarga a medico.mp4.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Cargar .env raíz (HEYGEN_API_KEY) — tsx no lo hace solo.
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]!]) process.env[m[1]!] = v;
    }
  }
} catch {}

import { uploadTalkingPhoto, listHeyGenVoices, generateHeyGenVideoAndWait } from '../apps/web/lib/heygen';

const PHOTO = resolve(process.cwd(), 'storage/proto-composite/medico-green.png');
const OUT = resolve(process.cwd(), 'storage/proto-composite/medico.mp4');
// Narración del médico para las PRIMERAS escenas (hook + presenta a Rosa).
const SCRIPT =
  'Sientes la cara hinchada, con papada y retención de líquido. Mira este caso que me sorprendió: aquí observamos sus ojeras y su papada marcada, tal como te muestro.';

async function main(): Promise<void> {
  console.log('1) subiendo foto → talking_photo...');
  const tpId = await uploadTalkingPhoto(PHOTO);
  console.log('   talking_photo_id =', tpId);

  console.log('2) buscando voz ES masculina...');
  const voices = await listHeyGenVoices();
  const es = voices.filter((v) => /spanish|español/i.test(v.language));
  const male = es.find((v) => /male|masc|hombre/i.test(v.gender)) ?? es[0] ?? voices[0];
  console.log(`   ${es.length} voces ES de ${voices.length} totales`);
  console.log(`   elegida: ${male?.name} (${male?.voiceId}) [${male?.gender}/${male?.language}]`);
  if (!male) throw new Error('no hay voces disponibles');

  console.log('3) generando clip (HeyGen)... (puede tardar varios minutos)');
  const { videoId, videoUrl } = await generateHeyGenVideoAndWait({
    talkingPhotoId: tpId,
    voiceId: male.voiceId,
    text: SCRIPT,
    width: 720,
    height: 1280,
    maxWaitSec: 540,
    onPoll: (s, i) => console.log(`   poll#${i}: ${s.status}`),
  });
  console.log('   video_id =', videoId);
  console.log('   url =', videoUrl);

  console.log('4) descargando →', OUT);
  const resp = await fetch(videoUrl);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(OUT, buf);
  console.log(`OK ${(buf.length / 1024 / 1024).toFixed(1)} MB · talking_photo_id=${tpId} · voice=${male.voiceId}`);
}
void main();
