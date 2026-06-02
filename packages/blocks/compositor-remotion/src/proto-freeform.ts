// DEMO de la pieza clave por el MOTOR REAL (PlanoEscenas + FreeformElement):
// una escena con composición libre = fondo (persona) + MÉDICA recortada por
// chroma key + anotación (círculo+flecha) + caption. Prueba que el sistema de
// composición existente, ya extendido, hace la edición estilo CapCut.
// Uso: tsx proto-freeform.ts <workDir> <outPath>
import { renderComposition } from './render.js';

async function main(): Promise<void> {
  const workDir = process.argv[2];
  const outputPath = process.argv[3];
  if (!workDir || !outputPath) {
    console.error('uso: proto-freeform <workDir> <outputPath>');
    process.exit(2);
    return;
  }
  console.log('Render PlanoEscenas freeform (cutout médica + anotación + caption)...');
  const res = await renderComposition({
    composition: 'PlanoEscenas',
    workDir,
    outputPath,
    durationInFrames: 150,
    fps: 30,
    width: 1080,
    height: 1920,
    onProgress: (p) => {
      if (Math.round(p * 100) % 25 === 0) console.log(`  ${Math.round(p * 100)}%`);
    },
    inputProps: {
      audioSrc: '',
      scenes: [
        {
          imageSrc: 'person.png',
          durationSeconds: 5,
          composition: [
            { id: 'bg', kind: 'image', imageSrc: 'bg-woman.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            { id: 'medica', kind: 'video', videoSrc: 'medica-anim-node.webm', rect: { xPct: 32, yPct: 24, widthPct: 72, heightPct: 76 }, zIndex: 1, fit: 'contain', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            { id: 'ann', kind: 'annotation', rect: { xPct: 43, yPct: 25, widthPct: 17, heightPct: 8 }, annotation: { shape: 'circle-arrow', color: '#FF3B30', fromXPct: 48, fromYPct: 44 }, zIndex: 2, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            { id: 'cap', kind: 'text', text: 'y su papada', rect: { xPct: 8, yPct: 82, widthPct: 84, heightPct: 9 }, zIndex: 3, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
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
