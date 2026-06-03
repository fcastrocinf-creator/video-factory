// PARTE IMPORTANTE (Estilo CapCut) con la PERSONA UGC REAL (Veo, escena real):
//   fondo = Rosa (usuaria) · médico UGC en PiP de CAJA (su consulta, esquina, bordes
//   redondeados — sin matting todavía) · círculos ROJOS en ojeras + papada · voz del
//   médico. SIN subtítulos (el owner no los quiere).
// El recorte "flotante" del médico (sin fondo) = matting, refinamiento posterior.
// Uso: tsx proto-ugc-edit.ts <workDir> <outPath>
import { renderComposition } from './render.js';

async function main(): Promise<void> {
  const workDir = process.argv[2];
  const outputPath = process.argv[3];
  if (!workDir || !outputPath) {
    console.error('uso: proto-ugc-edit <workDir> <outputPath>');
    process.exit(2);
    return;
  }
  const fps = 30;
  const dur = 7.5; // clip recortado antes de la transición que Veo metió al final (~8.1s)
  const durF = dur * fps;
  const annStart = 2.5;

  console.log('Render Estilo CapCut con médico UGC real (PiP caja + círculos, sin subtítulos)...');
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
      audioSrc: 'medico-ugc.wav',
      scenes: [
        {
          imageSrc: 'rosa-dia1.png',
          durationSeconds: dur,
          composition: [
            // Fondo: la usuaria (Rosa, día 1 — hinchada).
            { id: 'bg', kind: 'image', imageSrc: 'rosa-dia1.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // Médico UGC en PiP de CAJA (su consulta visible, esquina inf-izq, bordes redondeados).
            { id: 'medico', kind: 'video', videoSrc: 'medico-ugc-veo.mp4', rect: { xPct: 2, yPct: 63, widthPct: 34, heightPct: 35 }, zIndex: 2, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 8 },
            // Círculo ROJO en las OJERAS.
            { id: 'ann_ojeras', kind: 'annotation', rect: { xPct: 33, yPct: 21, widthPct: 34, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: annStart, endSeconds: dur },
            // Círculo ROJO en la PAPADA.
            { id: 'ann_papada', kind: 'annotation', rect: { xPct: 37, yPct: 41, widthPct: 26, heightPct: 10 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: annStart, endSeconds: dur },
          ],
        },
      ],
      subtitleTrack: { language: 'es', words: [], lines: [] },
      subtitlesConfig: { style: 'word_level_kinetic', font: 'Inter', fontSize: 64, color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 4, highlightColor: '#FFE600', position: 'bottom', allCaps: false },
      animatedScenes: false,
      kenBurns: false,
    },
  });
  console.log(`OK → ${res.outputPath} (${(res.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
}
void main();
