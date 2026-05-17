import { describe, expect, it } from 'vitest';
import type { SubtitleWord } from '@video-factory/contracts';
import { groupWordsIntoLines } from '../src/grouping.js';
import { parseSpeechTime } from '../src/client.js';

function makeWord(word: string, start: number, end: number): SubtitleWord {
  return { word, startTimeSeconds: start, endTimeSeconds: end };
}

describe('groupWordsIntoLines', () => {
  it('agrupa palabras en chunks del tamaño maxWordsPerLine', () => {
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
    expect(lines[1]?.text).toBe('en la mañana');
  });

  it('quiebra antes del max cuando una palabra termina en puntuación fuerte', () => {
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

  it('flusha la última línea aunque no alcance el max', () => {
    const lines = groupWordsIntoLines([makeWord('Solo', 0, 0.5), makeWord('dos', 0.5, 1)], {
      maxWordsPerLine: 4,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Solo dos');
  });

  it('retorna array vacío si no hay palabras o maxWordsPerLine <= 0', () => {
    expect(groupWordsIntoLines([])).toEqual([]);
    expect(groupWordsIntoLines([makeWord('x', 0, 1)], { maxWordsPerLine: 0 })).toEqual([]);
  });

  it('respeta el mínimo de 2 palabras antes de quebrar por puntuación', () => {
    const lines = groupWordsIntoLines(
      [makeWord('Wow!', 0, 0.5), makeWord('mira', 0.5, 1), makeWord('esto', 1, 1.5)],
      { maxWordsPerLine: 4, breakOnSentenceEnd: true },
    );
    expect(lines).toHaveLength(1);
  });

  it('startTime y endTime corresponden a primera y última palabra de cada línea', () => {
    const words = [
      makeWord('A', 0, 0.2),
      makeWord('B', 0.2, 0.4),
      makeWord('C', 0.4, 0.6),
      makeWord('D', 0.6, 0.8),
    ];
    const lines = groupWordsIntoLines(words, { maxWordsPerLine: 2, breakOnSentenceEnd: false });
    expect(lines[0]?.startTimeSeconds).toBe(0);
    expect(lines[0]?.endTimeSeconds).toBe(0.4);
    expect(lines[1]?.startTimeSeconds).toBe(0.4);
    expect(lines[1]?.endTimeSeconds).toBe(0.8);
  });
});

describe('parseSpeechTime', () => {
  it('parsea "1.200s" como 1.2', () => {
    expect(parseSpeechTime('1.200s')).toBeCloseTo(1.2, 3);
  });

  it('parsea "0s" como 0', () => {
    expect(parseSpeechTime('0s')).toBe(0);
  });

  it('parsea "12s" como 12 entero', () => {
    expect(parseSpeechTime('12s')).toBe(12);
  });

  it('parsea fraccional sin parte entera explícita como 0.xyz', () => {
    expect(parseSpeechTime('0.005s')).toBeCloseTo(0.005, 4);
  });

  it('soporta valores grandes (5 min de audio)', () => {
    expect(parseSpeechTime('325.456s')).toBeCloseTo(325.456, 3);
  });

  it('retorna 0 si el formato no matchea', () => {
    expect(parseSpeechTime('not-a-time')).toBe(0);
    expect(parseSpeechTime('1.2')).toBe(0); // falta la "s"
  });
});
