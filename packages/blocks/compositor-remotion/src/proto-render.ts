// PROTOTIPO: render de ComposicionAvanzada (edición/composición estilo CapCut).
// Demuestra: fondo (video) + overlay PiP de persona real + overlay recortado por
// chroma key + caption karaoke + anotación (círculo+flecha).
// Uso (desde la raíz del repo):
//   node ... o tsx packages/blocks/compositor-remotion/src/proto-render.ts <workDir> <outPath>
import { renderComposition } from './render.js';

async function main(): Promise<void> {
  const workDir = process.argv[2];
  const outputPath = process.argv[3];
  if (!workDir || !outputPath) {
    console.error('uso: proto-render <workDir> <outputPath>');
    process.exit(2);
    return;
  }
  console.log('Renderizando ComposicionAvanzada...');
  const res = await renderComposition({
    composition: 'ComposicionAvanzada',
    workDir,
    outputPath,
    durationInFrames: 180,
    fps: 30,
    width: 1080,
    height: 1920,
    onProgress: (p) => {
      if (Math.round(p * 100) % 20 === 0) console.log(`  ${Math.round(p * 100)}%`);
    },
    inputProps: {
      backgroundSrc: 'bg.mp4',
      backgroundIsVideo: true,
      overlays: [
        // Overlay 1: persona REAL como burbuja PiP (composición multi-capa).
        { src: 'person.png', isVideo: false, xPct: 55, yPct: 44, widthPct: 42, rounded: true, border: true, startSec: 0.2 },
        // Overlay 2: sujeto sobre VERDE, recortado por chroma key (prueba del recorte).
        { src: 'badge-green.png', isVideo: false, chromaKey: true, xPct: 6, yPct: 9, widthPct: 26, startSec: 0.5 },
      ],
      caption: { text: 'y su papada', highlightWord: 'papada', startSec: 0.3 },
      annotation: { xPct: 40, yPct: 58, rxPct: 13, ryPct: 7, arrowFromXPct: 64, arrowFromYPct: 76, startSec: 0.6 },
    },
  });
  console.log(`OK → ${res.outputPath} (${(res.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${res.durationSeconds}s)`);
}

void main();
