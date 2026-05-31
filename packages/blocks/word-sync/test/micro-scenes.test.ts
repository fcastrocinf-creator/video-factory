import { describe, expect, it } from 'vitest';
import {
  cleanWord,
  tokenizeFromAlignment,
  detectEnumerations,
  planMicroScenes,
  findWordTime,
} from '../src/micro-scenes.js';
import type { CharAlignment, WordTiming } from '../src/types.js';
import { LODO_WORDS } from './fixtures/lodo-words.js';

describe('cleanWord', () => {
  it('quita puntuación y baja a minúsculas, conserva acentos', () => {
    expect(cleanWord('¿Cara,')).toBe('cara');
    expect(cleanWord('piernas.')).toBe('piernas');
    expect(cleanWord('LINFÁTICO')).toBe('linfático');
  });
});

describe('tokenizeFromAlignment', () => {
  it('reconstruye palabras con sus tiempos desde la alineación por carácter', () => {
    // "ab cd": a@0-0.1 b@0.1-0.2 (espacio) c@0.3-0.4 d@0.4-0.5
    const al: CharAlignment = {
      characters: ['a', 'b', ' ', 'c', 'd'],
      character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4],
      character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
    };
    const words = tokenizeFromAlignment(al);
    expect(words).toHaveLength(2);
    expect(words[0]).toEqual({ word: 'ab', start: 0, end: 0.2 });
    expect(words[1]).toEqual({ word: 'cd', start: 0.3, end: 0.5 });
  });
});

describe('planMicroScenes — caso real LODO', () => {
  const scenes = planMicroScenes(LODO_WORDS);

  it('detecta la enumeración final cara/abdomen/piernas como 3 micro-escenas', () => {
    const anchors = scenes.map((s) => s.anchor);
    expect(anchors).toContain('cara');
    expect(anchors).toContain('abdomen');
    expect(anchors).toContain('piernas');
  });

  it('cada micro-escena cae EXACTO en su palabra (ventanas contiguas)', () => {
    const cara = scenes.find((s) => s.anchor === 'cara')!;
    const abdomen = scenes.find((s) => s.anchor === 'abdomen')!;
    const piernas = scenes.find((s) => s.anchor === 'piernas')!;

    // cara arranca con "tu" (~15.45) y termina donde arranca "tu abdomen" (16.01)
    expect(cara.start).toBeCloseTo(15.453, 2);
    expect(cara.end).toBeCloseTo(abdomen.start, 3);
    // abdomen termina donde arranca "tus piernas" (16.80)
    expect(abdomen.end).toBeCloseTo(piernas.start, 3);
    // piernas cierra al final de la pista
    expect(piernas.end).toBeCloseTo(17.926, 2);
  });

  it('las micro-escenas no se solapan y van en orden', () => {
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i]!.start).toBeGreaterThanOrEqual(scenes[i - 1]!.start);
    }
  });
});

describe('detectEnumerations — robustez', () => {
  it('NO marca enumeración en una oración normal sin lista', () => {
    // "Hoy comí pan y luego salí." -> no es enumeración paralela
    const words: WordTiming[] = [
      { word: 'Hoy', start: 0, end: 0.3 },
      { word: 'comí', start: 0.3, end: 0.6 },
      { word: 'pan', start: 0.6, end: 0.9 },
      { word: 'y', start: 0.9, end: 1.0 },
      { word: 'luego', start: 1.0, end: 1.3 },
      { word: 'salí.', start: 1.3, end: 1.7 },
    ];
    expect(detectEnumerations(words)).toHaveLength(0);
  });

  it('detecta una lista de sustantivos pelados (manzanas, peras y uvas)', () => {
    const words: WordTiming[] = [
      { word: 'manzanas,', start: 0, end: 0.5 },
      { word: 'peras', start: 0.5, end: 1.0 },
      { word: 'y', start: 1.0, end: 1.1 },
      { word: 'uvas.', start: 1.1, end: 1.6 },
    ];
    const enums = detectEnumerations(words);
    expect(enums).toHaveLength(1);
    expect(enums[0]!.items.map((i) => i.anchor)).toEqual(['manzanas', 'peras', 'uvas']);
  });
});

describe('findWordTime', () => {
  it('encuentra la ventana de una palabra puntual', () => {
    const w = findWordTime(LODO_WORDS, 'abdomen');
    expect(w?.start).toBeCloseTo(16.149, 2);
  });

  it('respeta la ocurrencia N (linfático aparece 2 veces)', () => {
    const first = findWordTime(LODO_WORDS, 'linfático', 1);
    const second = findWordTime(LODO_WORDS, 'linfático', 2);
    expect(first?.start).toBeCloseTo(3.216, 2);
    expect(second?.start).toBeCloseTo(11.796, 2);
  });
});
