// Alineación PERFECTA de escenas a la narración (word-level).
//
// El problema que resuelve: la alineación por interpolación de caracteres sobre
// los segmentos del TTS es aproximada y desfasa el visual del audio (una frase
// corta puede quedar durando más que una larga). Con los timestamps POR PALABRA
// de ElevenLabs, cada escena se ancla a las palabras EXACTAS que se narran en
// ella → el corte cae justo cuando el narrador pasa a lo siguiente.
//
// Pura y genérica (cualquier objeto con {text,startTimeSeconds,endTimeSeconds}).

import type { WordTiming } from './types.js';
import { cleanWord } from './micro-scenes.js';

export interface AlignableScene {
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function tokenize(text: string): string[] {
  return cleanWord(text).split(/\s+/).filter(Boolean);
}

/**
 * Re-alinea las escenas a la secuencia de palabras cronometradas. Cada escena se
 * consume secuencialmente del stream de palabras (su texto = un tramo contiguo de
 * la narración), fijando start/end a los tiempos reales. Luego hace los cortes
 * CONTIGUOS (sin huecos) y cubre toda la pista de audio.
 *
 * Si una escena no matchea (texto raro), avanza con una ventana de búsqueda; nunca
 * rompe el orden monotónico.
 */
export function alignScenesToWords<T extends AlignableScene>(scenes: T[], words: WordTiming[]): T[] {
  if (words.length === 0 || scenes.length === 0) return scenes;

  const wclean = words.map((w) => cleanWord(w.word));
  const audioEnd = words[words.length - 1]!.end;
  const SEARCH = 8; // ventana para reencontrar el inicio si hubo drift

  let cursor = 0;
  const result = scenes.map((scene) => {
    const tokens = tokenize(scene.text);
    if (tokens.length === 0) {
      const t = words[Math.min(cursor, words.length - 1)]!.start;
      return { ...scene, startTimeSeconds: round3(t), endTimeSeconds: round3(t) };
    }
    // Inicio: idealmente words[cursor] == tokens[0]. Si no, buscamos adelante.
    let start = cursor;
    if (wclean[start] !== tokens[0]) {
      for (let j = cursor; j < Math.min(words.length, cursor + SEARCH); j++) {
        if (wclean[j] === tokens[0]) {
          start = j;
          break;
        }
      }
    }
    const end = Math.min(words.length - 1, start + tokens.length - 1);
    cursor = end + 1;
    return {
      ...scene,
      startTimeSeconds: round3(words[start]!.start),
      endTimeSeconds: round3(words[end]!.end),
    };
  });

  // Cortes CONTIGUOS: cada escena se mantiene hasta que arranca la siguiente
  // (cubre las pausas) → el cambio de visual cae exacto en la próxima narración.
  for (let i = 0; i < result.length - 1; i++) {
    result[i]!.endTimeSeconds = result[i + 1]!.startTimeSeconds;
  }
  // La primera arranca en 0 (cubre silencio inicial); la última cierra con el audio.
  result[0]!.startTimeSeconds = 0;
  result[result.length - 1]!.endTimeSeconds = round3(audioEnd);

  // Garantizar duraciones positivas + orden monotónico (defensivo).
  for (let i = 0; i < result.length; i++) {
    if (result[i]!.endTimeSeconds <= result[i]!.startTimeSeconds) {
      result[i]!.endTimeSeconds = round3(result[i]!.startTimeSeconds + 0.3);
    }
  }
  return result;
}
