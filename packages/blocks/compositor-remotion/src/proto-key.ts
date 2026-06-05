// TRAMO CLAVE — VOZ NATIVA del médico (Veo 3.1) de punta a punta + PiP con MOVIMIENTO:
//   1) médico HOOK (clip Veo, su voz nativa: "Sientes la cara hinchada, con papada y
//      retención. Tienes que ver este caso.") →
//   2) Rosa ANTES (still) + médico en PiP (clip Veo OFF, su voz nativa: "Aquí observamos
//      ojeras y papada... en pocas semanas más firme") con MOVIMIENTO (corte y posición)
//      + CÍRCULOS sincronizados a "ojeras"/"papada" del OFF →
//   3) Rosa INTERMEDIO→DESPUÉS (mejora) → 4) PRODUCTO (packshot, cierre corto).
//   Audio = voz NATIVA del médico (hook clip + off clip), NADA de TTS de ElevenLabs.
//   El compositor MUTEA los videos; el audio sale de combined-key.mp3 (hook+off nativos)
//   → el lipsync calza por construcción (voz y labios del mismo modelo). Sin subtítulos.
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
    hookDur: number; offDur: number;
  };
  const HOOK_END = m.hookDur;             // fin del hook (médico full, voz nativa)
  const ROSA_END = m.hookDur + m.offDur;  // el tramo de Rosa dura el clip OFF (su voz nativa)
  // El OFF dice "ojeras/papada" al inicio y "en pocas semanas más firme" después → cortes:
  const ANTES_END = HOOK_END + 3.7;       // Rosa ANTES (hinchada), mientras menciona ojeras/papada
  const INTER_END = HOOK_END + 5.2;       // breve INTERMEDIO (transición de mejora)
  const OJERAS_T = HOOK_END + 1.78;       // "ojeras" se dice a 1.78s del off
  const PAPADA_T = HOOK_END + 2.58;       // "papada" se dice a 2.58s del off
  const PRODUCT = 1.0;                    // cierre MUY corto (mínimo silencio tras la narración)
  const TOTAL = ROSA_END + PRODUCT;
  const fps = 30;

  console.log(`Render TRAMO CLAVE (hook→Rosa+PiP→producto, ${TOTAL.toFixed(1)}s)...`);
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
            // 1) médico HOOK = clip Veo (voz NATIVA, lipsync real). Muteado por el compositor;
            //    su voz sale de combined-key.mp3 (primer tramo) → lipsync calza.
            { id: 'medico-hook', kind: 'video', videoSrc: 'medico-hook-veo.mp4', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: 0, endSeconds: HOOK_END },
            // teaser del PRODUCTO temprano (callout en esquina) mientras el médico habla.
            { id: 'prod-teaser', kind: 'image', imageSrc: 'packshot.jpg', rect: { xPct: 53, yPct: 54, widthPct: 45, heightPct: 38 }, zIndex: 3, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 10, startSeconds: 2.2, endSeconds: HOOK_END },
            // 2) Rosa ANTES (still, hinchada) + círculos sincronizados a la voz nativa del OFF.
            { id: 'rosa-antes', kind: 'image', imageSrc: 'estado1_hinchada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: HOOK_END, endSeconds: ANTES_END },
            { id: 'ann-ojeras', kind: 'annotation', rect: { xPct: 25, yPct: 35, widthPct: 50, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: OJERAS_T, endSeconds: ANTES_END },
            { id: 'ann-papada', kind: 'annotation', rect: { xPct: 33, yPct: 71, widthPct: 34, heightPct: 9 }, annotation: { shape: 'circle', color: '#FF3B30' }, zIndex: 4, rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: PAPADA_T, endSeconds: ANTES_END },
            // 3) PROGRESIÓN: intermedio (estado2) → renovada (estado3), MISMA mujer.
            { id: 'rosa-intermedio', kind: 'image', imageSrc: 'estado2_media.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: ANTES_END, endSeconds: INTER_END },
            { id: 'rosa-despues', kind: 'image', imageSrc: 'estado3_renovada.png', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: INTER_END, endSeconds: ROSA_END },
            // PiP del médico CON MOVIMIENTO (corte y posición): el clip OFF (su voz nativa +
            // lipsync) recortado y posicionado en el recuadro durante TODO el tramo de Rosa.
            { id: 'medico-pip', kind: 'video', videoSrc: 'medico-off-veo.mp4', rect: { xPct: 64, yPct: 4, widthPct: 33, heightPct: 25 }, zIndex: 6, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 14, startSeconds: HOOK_END, endSeconds: ROSA_END },
            // PRODUCTO presente DURANTE el antes/después (ancla el resultado al producto, lo
            // pidió la compuerta): packshot chico en esquina inferior derecha — no tapa la
            // cara de Rosa (centro) ni el PiP del médico (arriba-derecha).
            { id: 'prod-corner', kind: 'image', imageSrc: 'packshot.jpg', rect: { xPct: 66, yPct: 68, widthPct: 31, heightPct: 27 }, zIndex: 5, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 10, startSeconds: HOOK_END, endSeconds: ROSA_END },
            // 4) PRODUCTO (packshot real, marca legible) — cierre corto.
            { id: 'producto', kind: 'image', imageSrc: 'packshot.jpg', rect: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 }, zIndex: 1, fit: 'cover', rotationDeg: 0, opacity: 1, cornerRadiusPct: 0, startSeconds: ROSA_END, endSeconds: TOTAL },
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
