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
    durationInFrames: 429,
    fps: 30,
    width: 1080,
    height: 1920,
    onProgress: (p) => {
      if (Math.round(p * 100) % 25 === 0) console.log(`  ${Math.round(p * 100)}%`);
    },
    inputProps: {
      audioSrc: 'doctor-audio.mp3',
      scenes: [
        {
          imageSrc: 'person.png',
          durationSeconds: 14.3,
          composition: [
            // Fondo: la usuaria UGC (todo el ad).
            { id: 'bg', kind: 'image', imageSrc: 'bg-woman.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // Médica recortada (video): aparece SOLO cuando la autoridad habla (S2: 4.13-10.82s).
            { id: 'medica', kind: 'video', videoSrc: 'medica-anim-node.webm', rect: { xPct: 32, yPct: 24, widthPct: 72, heightPct: 76 }, zIndex: 1, fit: 'contain', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 4.0, endSeconds: 9.2 },
            // Círculo en la papada cuando la usuaria la MENCIONA (final de S1).
            { id: 'ann1', kind: 'annotation', rect: { xPct: 42, yPct: 26, widthPct: 18, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 2.0, endSeconds: 4.3 },
            // Círculo + flecha cuando la médica explica (S2): señala la papada.
            { id: 'ann2', kind: 'annotation', rect: { xPct: 42, yPct: 26, widthPct: 18, heightPct: 9 }, annotation: { shape: 'circle-arrow', color: '#FF3B30', fromXPct: 50, fromYPct: 52 }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 4.8, endSeconds: 9.0 },
            // Captions por línea, sincronizados a cada voz.
            { id: 'cap1', kind: 'text', text: 'una papada que no se me iba', rect: { xPct: 6, yPct: 84, widthPct: 88, heightPct: 9 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 0, endSeconds: 4.13 },
            { id: 'cap2', kind: 'text', text: 'es retención de líquido', rect: { xPct: 6, yPct: 84, widthPct: 88, heightPct: 9 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 4.13, endSeconds: 7.6 },
            { id: 'cap3', kind: 'text', text: 'el drenaje linfático la desinflama', rect: { xPct: 6, yPct: 84, widthPct: 88, heightPct: 9 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 7.6, endSeconds: 10.82 },
            { id: 'cap4', kind: 'text', text: 'mira la diferencia', rect: { xPct: 6, yPct: 84, widthPct: 88, heightPct: 9 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 10.82, endSeconds: 14.24 },
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
