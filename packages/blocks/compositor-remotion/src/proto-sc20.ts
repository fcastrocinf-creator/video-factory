// PRUEBA DE FUEGO v2 — reproducción ~29s con arreglos de los validators:
//   - lipsync: AUDIO NATIVO de los clips (combined-native.mp3), no TTS superpuesto
//   - médico en PiP = VIDEO (se mueve), no imagen fija
//   - Rosa HINCHADA (no golpeada) + close-up con círculos afinados
//   - cortes por duración REAL de cada clip (manifest-sc20.json). Sin subtítulos.
// Uso: tsx proto-sc20.ts <workDir> <outPath>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderComposition } from './render.js';

async function main(): Promise<void> {
  const workDir = process.argv[2];
  const outputPath = process.argv[3];
  if (!workDir || !outputPath) {
    console.error('uso: proto-sc20 <workDir> <outputPath>');
    process.exit(2);
    return;
  }
  const man = JSON.parse(readFileSync(resolve(workDir, 'manifest-sc20.json'), 'utf8')) as {
    hookDur: number; rosaDur: number; explainDur: number; total: number;
  };
  const HOOK_END = man.hookDur;
  const ROSA_END = man.hookDur + man.rosaDur;
  const TOTAL = man.total;
  const EXPLAIN_CUT = Math.max(ROSA_END + 1, TOTAL - 5); // últimos ~5s: Rosa close-up + círculos
  const fps = 30;
  const durF = Math.round(TOTAL * fps);

  console.log(`Render PRUEBA DE FUEGO v2 (0-${TOTAL.toFixed(1)}s, corte a Rosa @${EXPLAIN_CUT.toFixed(1)}s)...`);
  const res = await renderComposition({
    composition: 'PlanoEscenas',
    workDir,
    outputPath,
    durationInFrames: durF,
    fps,
    width: 1080,
    height: 1920,
    onProgress: (p) => { if (Math.round(p * 100) % 20 === 0) console.log(`  ${Math.round(p * 100)}%`); },
    inputProps: {
      audioSrc: 'combined-native.mp3',
      scenes: [
        {
          imageSrc: 'rosa-hinchada.png',
          durationSeconds: TOTAL,
          composition: [
            { id: 'bg', kind: 'image', imageSrc: 'rosa-hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // 1) médico hook full
            { id: 'medico-hook', kind: 'video', videoSrc: 'medico-hook.mp4', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 0, endSeconds: HOOK_END },
            // 2) Rosa día-1 full
            { id: 'rosa', kind: 'video', videoSrc: 'rosa.mp4', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END, endSeconds: ROSA_END },
            // médico en PiP = VIDEO (se mueve), no imagen fija
            { id: 'medico-pip', kind: 'video', videoSrc: 'medico-hook.mp4', rect: { xPct: 2, yPct: 63, widthPct: 34, heightPct: 35 }, zIndex: 2, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 8, startSeconds: HOOK_END, endSeconds: ROSA_END },
            // 3a) médico explica full
            { id: 'medico-explain', kind: 'video', videoSrc: 'medico-explain.mp4', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: ROSA_END, endSeconds: EXPLAIN_CUT },
            // 3b) corte a Rosa close-up cuando dice "sus ojeras y su papada"
            { id: 'rosa-closeup', kind: 'image', imageSrc: 'rosa-hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: EXPLAIN_CUT, endSeconds: TOTAL },
            // círculos rojos afinados (ojeras más ancho cubre ambos ojos; papada más abajo)
            { id: 'ann-ojeras', kind: 'annotation', rect: { xPct: 27, yPct: 24, widthPct: 46, heightPct: 11 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: EXPLAIN_CUT + 0.3, endSeconds: TOTAL },
            { id: 'ann-papada', kind: 'annotation', rect: { xPct: 34, yPct: 55, widthPct: 32, heightPct: 12 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: EXPLAIN_CUT + 0.9, endSeconds: TOTAL },
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
