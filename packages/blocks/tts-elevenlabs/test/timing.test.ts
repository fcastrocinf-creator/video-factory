import { describe, expect, it } from 'vitest';
import type { ScriptSegment } from '@video-factory/contracts';
import { buildPrompt, computeSegmentTimings } from '../src/timing.js';

function makeSegment(text: string, pauseAfterMs = 0): ScriptSegment {
  return { text, pauseAfterMs, emphasisWords: [] };
}

describe('buildPrompt', () => {
  it('une segmentos con <break time="Xms"/> entre ellos', () => {
    const segments = [
      makeSegment('Hola.', 200),
      makeSegment('Mundo…', 300),
      makeSegment('Adiós.', 200),
    ];
    const prompt = buildPrompt(segments);
    expect(prompt).toBe('Hola. <break time="200ms"/> Mundo… <break time="300ms"/> Adiós.');
  });

  it('no agrega <break/> después del último segmento', () => {
    const segments = [makeSegment('Hola.', 200), makeSegment('Mundo.', 200)];
    expect(buildPrompt(segments)).toBe('Hola. <break time="200ms"/> Mundo.');
  });

  it('no agrega <break/> cuando pauseAfterMs es 0', () => {
    const segments = [makeSegment('Hola', 0), makeSegment('mundo.', 200)];
    expect(buildPrompt(segments)).toBe('Hola mundo.');
  });

  it('manejo de un solo segmento', () => {
    const segments = [makeSegment('Hola mundo.', 200)];
    expect(buildPrompt(segments)).toBe('Hola mundo.');
  });

  it('respeta pausas distintas (300ms ellipsis vs 200ms period)', () => {
    const segments = [
      makeSegment('Esto…', 300),
      makeSegment('es importante.', 200),
      makeSegment('Escucha.', 200),
    ];
    const prompt = buildPrompt(segments);
    expect(prompt).toContain('<break time="300ms"/>');
    expect(prompt.match(/<break time="200ms"\/>/g)).toHaveLength(1);
  });
});

describe('computeSegmentTimings', () => {
  it('distribuye la duración proporcionalmente al largo en caracteres', () => {
    const segments = [
      makeSegment('Hola.', 200), // 5 chars
      makeSegment('Mundo grande.', 200), // 13 chars
      makeSegment('Adiós.', 200), // 6 chars
    ];
    // total chars: 24. Durations: 5/24*12, 13/24*12, 6/24*12
    const result = computeSegmentTimings(segments, 12);
    expect(result).toHaveLength(3);
    expect(result[0]?.startTimeSeconds).toBe(0);
    expect(result[0]?.endTimeSeconds).toBeCloseTo(2.5, 1);
    expect(result[1]?.startTimeSeconds).toBeCloseTo(2.5, 1);
    expect(result[1]?.endTimeSeconds).toBeCloseTo(9, 1);
    expect(result[2]?.endTimeSeconds).toBe(12); // último: forzado al total
  });

  it('retorna array vacío si no hay segmentos', () => {
    expect(computeSegmentTimings([], 10)).toEqual([]);
  });

  it('preserva el texto de cada segmento', () => {
    const segments = [makeSegment('Uno.', 200), makeSegment('Dos.', 200)];
    const result = computeSegmentTimings(segments, 4);
    expect(result[0]?.text).toBe('Uno.');
    expect(result[1]?.text).toBe('Dos.');
  });

  it('el endTime del último segmento siempre es exactamente la duración total', () => {
    const segments = [
      makeSegment('Lorem ipsum dolor sit.', 200),
      makeSegment('Amet consectetur.', 200),
      makeSegment('Adipiscing elit.', 200),
    ];
    const result = computeSegmentTimings(segments, 7.3);
    expect(result.at(-1)?.endTimeSeconds).toBe(7.3);
  });

  it('start del segmento N es igual al end del segmento N-1', () => {
    const segments = [
      makeSegment('A.', 200),
      makeSegment('B.', 200),
      makeSegment('C.', 200),
    ];
    const result = computeSegmentTimings(segments, 6);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]?.startTimeSeconds).toBe(result[i - 1]?.endTimeSeconds);
    }
  });
});
