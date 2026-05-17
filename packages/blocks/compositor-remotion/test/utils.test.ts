import { describe, expect, it } from 'vitest';
import type { SubtitleLine, SubtitleWord } from '@video-factory/contracts';
import {
  clampedProgress,
  durationToFrames,
  findActiveLine,
  interpolateKenBurnsPan,
  interpolateKenBurnsZoom,
  isWordActive,
} from '../src/utils.js';

function makeLine(start: number, end: number): SubtitleLine {
  return { text: '', startTimeSeconds: start, endTimeSeconds: end, wordRefs: [] };
}

function makeWord(start: number, end: number): SubtitleWord {
  return { word: 'x', startTimeSeconds: start, endTimeSeconds: end };
}

describe('findActiveLine', () => {
  const lines = [makeLine(0, 1), makeLine(1, 2.5), makeLine(2.5, 4)];

  it('encuentra la línea activa en el tiempo dado', () => {
    expect(findActiveLine(lines, 0.5)).toBe(lines[0]);
    expect(findActiveLine(lines, 1.7)).toBe(lines[1]);
    expect(findActiveLine(lines, 3.5)).toBe(lines[2]);
  });

  it('considera intervalo [start, end) → el endTime exacto no pertenece', () => {
    expect(findActiveLine(lines, 1.0)).toBe(lines[1]); // 1.0 ∈ línea 2 (no línea 1)
    expect(findActiveLine(lines, 2.5)).toBe(lines[2]);
  });

  it('retorna null si no hay línea activa', () => {
    expect(findActiveLine(lines, -1)).toBeNull();
    expect(findActiveLine(lines, 100)).toBeNull();
  });

  it('retorna null si lines está vacío', () => {
    expect(findActiveLine([], 5)).toBeNull();
  });
});

describe('isWordActive', () => {
  it('true cuando time ∈ [start, end)', () => {
    const w = makeWord(1.0, 2.0);
    expect(isWordActive(w, 1.0)).toBe(true);
    expect(isWordActive(w, 1.5)).toBe(true);
    expect(isWordActive(w, 1.99)).toBe(true);
  });

  it('false en el endTime exacto', () => {
    expect(isWordActive(makeWord(1.0, 2.0), 2.0)).toBe(false);
  });

  it('false antes del start', () => {
    expect(isWordActive(makeWord(1.0, 2.0), 0.5)).toBe(false);
  });
});

describe('clampedProgress', () => {
  it('0 al frame 0', () => {
    expect(clampedProgress(0, 100)).toBe(0);
  });

  it('1 al último frame', () => {
    expect(clampedProgress(99, 100)).toBe(1);
  });

  it('aproximadamente 0.5 a la mitad', () => {
    expect(clampedProgress(50, 101)).toBeCloseTo(0.5, 2);
  });

  it('clampea valores negativos a 0', () => {
    expect(clampedProgress(-10, 100)).toBe(0);
  });

  it('clampea valores >1 a 1', () => {
    expect(clampedProgress(200, 100)).toBe(1);
  });

  it('retorna 0 si totalFrames es 0 o negativo', () => {
    expect(clampedProgress(50, 0)).toBe(0);
    expect(clampedProgress(50, -10)).toBe(0);
  });
});

describe('interpolateKenBurnsZoom', () => {
  it('arranca en zoomStart y termina en zoomEnd cuando enabled=true', () => {
    expect(interpolateKenBurnsZoom(0, 100, 1.0, 1.15, true)).toBe(1.0);
    expect(interpolateKenBurnsZoom(99, 100, 1.0, 1.15, true)).toBeCloseTo(1.15, 5);
  });

  it('retorna zoomStart constante cuando enabled=false', () => {
    expect(interpolateKenBurnsZoom(0, 100, 1.0, 1.15, false)).toBe(1.0);
    expect(interpolateKenBurnsZoom(50, 100, 1.0, 1.15, false)).toBe(1.0);
    expect(interpolateKenBurnsZoom(99, 100, 1.0, 1.15, false)).toBe(1.0);
  });

  it('interpola linealmente a la mitad', () => {
    expect(interpolateKenBurnsZoom(50, 101, 1.0, 1.2, true)).toBeCloseTo(1.1, 2);
  });
});

describe('interpolateKenBurnsPan', () => {
  it('arranca en 0 y termina en panEnd', () => {
    expect(interpolateKenBurnsPan(0, 100, -20, true)).toBeCloseTo(0, 5);
    expect(interpolateKenBurnsPan(99, 100, -20, true)).toBeCloseTo(-20, 5);
  });

  it('retorna 0 cuando enabled=false', () => {
    expect(interpolateKenBurnsPan(50, 100, -20, false)).toBe(0);
  });
});

describe('durationToFrames', () => {
  it('multiplica duración por fps redondeando hacia arriba', () => {
    expect(durationToFrames(2, 30)).toBe(60);
    expect(durationToFrames(2.5, 30)).toBe(75);
    expect(durationToFrames(2.51, 30)).toBe(76);
  });

  it('mínimo de 1 frame', () => {
    expect(durationToFrames(0, 30)).toBe(1);
    expect(durationToFrames(0.001, 30)).toBe(1);
  });

  it('manejo de un video de 5 minutos @ 30fps', () => {
    expect(durationToFrames(300, 30)).toBe(9000);
  });
});
