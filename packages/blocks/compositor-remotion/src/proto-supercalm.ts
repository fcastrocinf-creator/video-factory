// DEMO de VALIDACIÓN técnica — reproducción (rip) del formato SuperCalm con personajes
// propios, sobre el MOTOR REAL (PlanoEscenas + FreeformElement):
//   fondo = Rosa (usuaria UGC) · médico RECORTADO (chroma→webm alpha) en PiP esquina
//   hablando con lipsync (HeyGen) · círculos ROJOS en ojeras + papada · captions · voz.
// Prueba que el sistema crea técnicamente este tipo de ad complejo.
// Uso: tsx proto-supercalm.ts <workDir> <outPath>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderComposition } from './render.js';

async function main(): Promise<void> {
  const workDir = process.argv[2];
  const outputPath = process.argv[3];
  if (!workDir || !outputPath) {
    console.error('uso: proto-supercalm <workDir> <outputPath>');
    process.exit(2);
    return;
  }
  const manifest = JSON.parse(readFileSync(resolve(workDir, 'manifest.json'), 'utf8')) as {
    durationSec: number;
    fps: number;
    audioFile: string;
  };
  const fps = 30;
  const dur = manifest.durationSec;
  const durF = Math.round(dur * fps);
  // El médico empieza a señalar ojeras/papada en la 2ª mitad de su narración.
  const annStart = Math.min(dur - 0.5, Math.max(2, dur * 0.55));

  console.log(`Render PlanoEscenas SuperCalm-validación (dur=${dur}s, ann@${annStart.toFixed(1)}s)...`);
  const res = await renderComposition({
    composition: 'PlanoEscenas',
    workDir,
    outputPath,
    durationInFrames: durF,
    fps,
    width: 1080,
    height: 1920,
    onProgress: (p) => {
      if (Math.round(p * 100) % 20 === 0) console.log(`  ${Math.round(p * 100)}%`);
    },
    inputProps: {
      audioSrc: manifest.audioFile,
      scenes: [
        {
          imageSrc: 'rosa-dia1.png',
          durationSeconds: dur,
          composition: [
            // Fondo: la usuaria (Rosa, día 1 — hinchada).
            { id: 'bg', kind: 'image', imageSrc: 'rosa-dia1.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // Médico recortado (video alpha) en PiP esquina inferior izquierda — habla con lipsync.
            { id: 'medico', kind: 'video', videoSrc: 'medico_cut.webm', rect: { xPct: 1, yPct: 56, widthPct: 40, heightPct: 44 }, zIndex: 2, fit: 'contain', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // Círculo ROJO en las OJERAS (cuando el médico las menciona).
            { id: 'ann_ojeras', kind: 'annotation', rect: { xPct: 32, yPct: 28, widthPct: 36, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: annStart, endSeconds: dur },
            // Círculo ROJO en la PAPADA.
            { id: 'ann_papada', kind: 'annotation', rect: { xPct: 36, yPct: 49, widthPct: 28, heightPct: 12 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: annStart, endSeconds: dur },
            // Captions (sincronizados aprox. a la narración del médico).
            { id: 'cap1', kind: 'text', text: 'la cara hinchada, con papada y retención', textColor: '#FFFF00', rect: { xPct: 5, yPct: 84, widthPct: 90, heightPct: 8 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 0, endSeconds: annStart },
            { id: 'cap2', kind: 'text', text: 'sus ojeras y su papada marcada', textColor: '#FFFF00', rect: { xPct: 5, yPct: 84, widthPct: 90, heightPct: 8 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: annStart, endSeconds: dur },
          ],
        },
      ],
      subtitleTrack: { language: 'es', words: [], lines: [] },
      subtitlesConfig: {
        style: 'word_level_kinetic',
        font: 'Inter',
        fontSize: 64,
        color: '#FFFFFF',
        strokeColor: '#000000',
        strokeWidth: 4,
        highlightColor: '#FFE600',
        position: 'bottom',
        allCaps: false,
      },
      animatedScenes: false,
      kenBurns: false,
    },
  });
  console.log(`OK → ${res.outputPath} (${(res.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
}
void main();
