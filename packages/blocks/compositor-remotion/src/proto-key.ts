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
          imageSrc: 'rosa-hinchada.png',
          durationSeconds: TOTAL,
          composition: [
            { id: 'bg', kind: 'image', imageSrc: 'rosa-hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 0, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0 },
            // 1) médico hook (full)
            { id: 'medico-hook', kind: 'video', videoSrc: 'medico-hook.mp4', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 0, endSeconds: HOOK_END },
            // Teaser del PRODUCTO temprano (gate: "producto muy tarde"). Callout en esquina con
            // etiqueta limpia (tapa el texto basura) mientras el médico habla del problema.
            { id: 'prod-teaser', kind: 'image', imageSrc: 'producto.png', rect: { xPct: 65, yPct: 57, widthPct: 33, heightPct: 33 }, zIndex: 3, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 10, startSeconds: 4.5, endSeconds: HOOK_END },
            { id: 'prod-teaser-label', kind: 'text', text: 'Nello SuperCalm', textColor: '#0A2540', backgroundColor: '#F5F2ED', rect: { xPct: 65, yPct: 79, widthPct: 33, heightPct: 5 }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 4.5, endSeconds: HOOK_END },
            // 2) Rosa ANTES (still) + médico en VOZ EN OFF (sin cara → imposible desfasar labios) + círculos
            { id: 'rosa-antes', kind: 'image', imageSrc: 'rosa-hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END, endSeconds: ANTES_END },
            { id: 'ann-ojeras', kind: 'annotation', rect: { xPct: 29, yPct: 25, widthPct: 42, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END + 0.4, endSeconds: ANTES_END },
            { id: 'ann-papada', kind: 'annotation', rect: { xPct: 34, yPct: 53, widthPct: 32, heightPct: 11 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END + 1.4, endSeconds: ANTES_END },
            // 3) Rosa DESPUÉS = FOTO realista (soul_2, MISMA mujer del antes, deshinchada y
            // sana), ESTÁTICA. El médico narra en VOZ EN OFF → cero lipsync, sin cara "alien".
            { id: 'rosa-despues', kind: 'image', imageSrc: 'rosa-final.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: ANTES_END, endSeconds: DESPUES_END },
            // 4) PRODUCTO + nombre legible
            { id: 'producto', kind: 'image', imageSrc: 'producto.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: DESPUES_END, endSeconds: TOTAL },
            // Etiqueta SÓLIDA legible que TAPA el texto basura/invertido del empaque (gate: producto ilegible).
            { id: 'producto-label', kind: 'text', text: 'Nello SuperCalm', textColor: '#0A2540', backgroundColor: '#F5F2ED', rect: { xPct: 20, yPct: 44, widthPct: 60, heightPct: 14 }, zIndex: 5, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: DESPUES_END, endSeconds: TOTAL },
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
