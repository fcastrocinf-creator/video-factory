import { describe, expect, it } from 'vitest';
import type { SubtitleWord } from '@video-factory/contracts';
import { groupWordsIntoLines } from '../src/grouping.js';

function makeWord(word: string, start: number, end: number): SubtitleWord {
  return { word, startTimeSeconds: start, endTimeSeconds: end };
}

describe('groupWordsIntoLines', () => {
  it('agrupa palabras en chunks de tamaño maxWordsPerLine', () => {
    const words = [
      makeWord('Si', 0.0, 0.18),
      makeWord('no', 0.18, 0.3),
      makeWord('tienes', 0.3, 0.62),
      makeWord('hambre', 0.62, 1.0),
      makeWord('en', 1.0, 1.15),
      makeWord('la', 1.15, 1.25),
      makeWord('mañana', 1.25, 1.7),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 4, breakOnSentenceEnd: false });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Si no tienes hambre');
    expect(lines[0]?.startTimeSeconds).toBe(0.0);
    expect(lines[0]?.endTimeSeconds).toBe(1.0);
    expect(lines[0]?.wordRefs).toEqual([0, 1, 2, 3]);
    expect(lines[1]?.text).toBe('en la mañana');
    expect(lines[1]?.wordRefs).toEqual([4, 5, 6]);
  });

  it('quiebra antes del max cuando una palabra termina en puntuación fuerte (breakOnSentenceEnd)', () => {
    const words = [
      makeWord('Hola', 0, 0.5),
      makeWord('mundo.', 0.5, 1.0),
      makeWord('Adiós', 1.0, 1.5),
      makeWord('amigo.', 1.5, 2.0),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 4, breakOnSentenceEnd: true });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Hola mundo.');
    expect(lines[1]?.text).toBe('Adiós amigo.');
  });

  it('no quiebra prematuramente cuando breakOnSentenceEnd es false', () => {
    const words = [
      makeWord('Hola', 0, 0.5),
      makeWord('mundo.', 0.5, 1.0),
      makeWord('Adiós', 1.0, 1.5),
      makeWord('amigo.', 1.5, 2.0),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 4, breakOnSentenceEnd: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Hola mundo. Adiós amigo.');
  });

  it('reconoce …, ? y ! como cierre de oración (respetando mínimo 2 palabras por línea)', () => {
    const words = [
      makeWord('Mira', 0, 0.5),
      makeWord('esto…', 0.5, 1.0),
      makeWord('Wow!', 1.0, 1.5),
      makeWord('Listo?', 1.5, 2.0),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 5, breakOnSentenceEnd: true });
    // "Mira esto…" quiebra (2 palabras, termina en …). "Wow!" sola no quiebra (1 palabra),
    // se agrupa con "Listo?" y ahí sí cierra (2 palabras, termina en ?).
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Mira esto…');
    expect(lines[1]?.text).toBe('Wow! Listo?');
  });

  it('flusha la última línea incluso si no alcanzó el max ni cierra con puntuación', () => {
    const words = [makeWord('Solo', 0, 0.5), makeWord('dos', 0.5, 1.0)];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 4 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Solo dos');
  });

  it('retorna array vacío si no hay palabras', () => {
    expect(groupWordsIntoLines([])).toEqual([]);
  });

  it('retorna array vacío si maxWordsPerLine es 0 o negativo', () => {
    const words = [makeWord('Hola', 0, 0.5)];
    expect(groupWordsIntoLines(words, { maxWordsPerLine: 0 })).toEqual([]);
    expect(groupWordsIntoLines(words, { maxWordsPerLine: -1 })).toEqual([]);
  });

  it('startTime de cada línea es el start de su primera palabra', () => {
    const words = [
      makeWord('A', 0, 0.2),
      makeWord('B', 0.2, 0.4),
      makeWord('C', 0.4, 0.6),
      makeWord('D', 0.6, 0.8),
      makeWord('E', 0.8, 1.0),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 2, breakOnSentenceEnd: false });
    expect(lines[0]?.startTimeSeconds).toBe(0);
    expect(lines[1]?.startTimeSeconds).toBe(0.4);
    expect(lines[2]?.startTimeSeconds).toBe(0.8);
  });

  it('endTime de cada línea es el end de su última palabra', () => {
    const words = [
      makeWord('A', 0, 0.2),
      makeWord('B', 0.2, 0.4),
      makeWord('C', 0.4, 0.6),
      makeWord('D', 0.6, 0.8),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 2, breakOnSentenceEnd: false });
    expect(lines[0]?.endTimeSeconds).toBe(0.4);
    expect(lines[1]?.endTimeSeconds).toBe(0.8);
  });

  it('wordRefs son índices contiguos al array original', () => {
    const words = [
      makeWord('A', 0, 0.2),
      makeWord('B', 0.2, 0.4),
      makeWord('C', 0.4, 0.6),
      makeWord('D', 0.6, 0.8),
      makeWord('E', 0.8, 1.0),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 2, breakOnSentenceEnd: false });
    expect(lines.flatMap((l) => l.wordRefs)).toEqual([0, 1, 2, 3, 4]);
  });

  it('no quiebra en puntuación si la línea sólo tiene 1 palabra (evita líneas de 1 palabra)', () => {
    // Si "Wow!" llega como primera palabra, no debe romper sola (mínimo 2 antes de break por puntuación).
    const words = [
      makeWord('Wow!', 0, 0.5),
      makeWord('mira', 0.5, 1.0),
      makeWord('esto', 1.0, 1.5),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 4, breakOnSentenceEnd: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Wow! mira esto');
  });
});
