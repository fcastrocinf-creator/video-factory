// TRAMO CLAVE (~20s) — LIPSYNC por AUDIO NATIVO del clip (no TTS superpuesto):
//   1) médico hook (UGC real, full, su voz nativa) → 2) Rosa ANTES (still, sin animar) +
//   médico en VOZ EN OFF (sin cara → no hay labios que desfasar) + CÍRCULOS ROJOS en
//   ojeras/papada sincronizados → 3) Rosa DESPUÉS (clip, su voz nativa = la TRANSFORMACIÓN)
//   → 4) PRODUCTO con ETIQUETA sólida legible que tapa el texto basura del empaque.
// Audio nativo de cada clip. Sin subtítulos (regla del owner).
// Uso: tsx proto-key.ts <workDir> <outPath>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderComposition } from './render.js';

async function main(): Promise<void> {
  const workDir = process.argv[2];
  const outputPath = process.argv[3];
  if (!workDir || !outputPath) {
    console.error('uso: proto-key <workDir> <outputPath>');
    process.exit(2);
    return;
  }
  const m = JSON.parse(readFileSync(resolve(workDir, 'manifest-key.json'), 'utf8')) as {
    hookDur: number; zonasDur: number; despuesDur: number;
  };
  const HOOK_END = m.hookDur;
  const ANTES_END = m.hookDur + m.zonasDur;
  const DESPUES_END = ANTES_END + m.despuesDur;
  // "Después" se parte en 2 beats con el MISMO audio: intermedio (estado2, ~40%) → renovada (estado3, ~60%).
  const INTER_END = ANTES_END + m.despuesDur * 0.4;
  const PRODUCT = 3;
  const TOTAL = DESPUES_END + PRODUCT;
  const fps = 30;

  console.log(`Render TRAMO CLAVE (hook→antes→después→producto, ${TOTAL.toFixed(1)}s)...`);
  const res = await renderComposition({
    composition: 'PlanoEscenas',
    workDir,
    outputPath,
    durationInFrames: Math.round(TOTAL * fps),
    fps,
    width: 1080,
    height: 1920,
    onProgress: (p) => { if (Math.round(p * 100) % 20 === 0) console.log(`  ${Math.round(p * 100)}%`); },
    inputProps: {
      audioSrc: 'combined-key.mp3',
      scenes: [
        {
          imageSrc: 'estado1_hinchada.png',
          durationSeconds: TOTAL,
          composition: [
            { id: 'bg', kind: 'image', imageSrc: 'estado1_hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // 1) médico hook (full)
            { id: 'medico-hook', kind: 'video', videoSrc: 'medico-hook.mp4', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 0, endSeconds: HOOK_END },
            // Teaser del PRODUCTO temprano (gate: "producto muy tarde"). Callout en esquina con
            // etiqueta limpia (tapa el texto basura) mientras el médico habla del problema.
            { id: 'prod-teaser', kind: 'image', imageSrc: 'packshot.jpg', rect: { xPct: 53, yPct: 54, widthPct: 45, heightPct: 38 }, zIndex: 3, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 10, startSeconds: 2.2, endSeconds: HOOK_END },
            // 2) Rosa ANTES (still) + médico en VOZ EN OFF (sin cara → imposible desfasar labios) + círculos
            { id: 'rosa-antes', kind: 'image', imageSrc: 'estado1_hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END, endSeconds: ANTES_END },
            { id: 'ann-ojeras', kind: 'annotation', rect: { xPct: 25, yPct: 35, widthPct: 50, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END + 2.3, endSeconds: ANTES_END }, // "ojeras" se dice a 2.34s del segmento
            { id: 'ann-papada', kind: 'annotation', rect: { xPct: 33, yPct: 71, widthPct: 34, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END + 3.6, endSeconds: ANTES_END }, // "papada" se dice a 3.30s del segmento
            // 3) PROGRESIÓN: estado2 (intermedio, "va mejorando") → estado3 (renovada). MISMA mujer
            // que el "antes" (misma foto base, editada para variar SOLO la hinchazón). Médico en VOZ
            // EN OFF → cero lipsync, sin cara "alien". Cortes secos alineados al audio "después".
            { id: 'rosa-intermedio', kind: 'image', imageSrc: 'estado2_media.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: ANTES_END, endSeconds: INTER_END },
            { id: 'rosa-despues', kind: 'image', imageSrc: 'estado3_renovada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: INTER_END, endSeconds: DESPUES_END },
            // 4) PRODUCTO + nombre legible
            { id: 'producto', kind: 'image', imageSrc: 'packshot.jpg', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: DESPUES_END, endSeconds: TOTAL },
            // (El packshot real ya trae la marca legible → sin etiqueta de parche.)
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
