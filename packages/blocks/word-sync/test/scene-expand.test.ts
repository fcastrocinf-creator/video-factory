import { describe, expect, it } from 'vitest';
import { expandEnumerationScenes, type TimedScene } from '../src/scene-expand.js';
import { LODO_WORDS } from './fixtures/lodo-words.js';

const baseScenes: TimedScene[] = [
  { index: 0, text: 'intro', startTimeSeconds: 0, endTimeSeconds: 15.116, imagePrompt: 'CGI lymphatic network' },
  {
    index: 1,
    text: 'recorre tu cara, tu abdomen y tus piernas',
    startTimeSeconds: 15.116,
    endTimeSeconds: 17.926,
    imagePrompt: 'woman with glowing lymphatic lines',
  },
];

describe('expandEnumerationScenes (cap 4)', () => {
  const out = expandEnumerationScenes(baseScenes, LODO_WORDS);

  it('parte la escena de enumeración en 3 micro-escenas (cara/abdomen/piernas)', () => {
    // escena 0 intacta + 3 micros (la cabeza <0.4s no se agrega)
    expect(out).toHaveLength(4);
    expect(out[1]!.imagePrompt).toContain('cara');
    expect(out[2]!.imagePrompt).toContain('abdomen');
    expect(out[3]!.imagePrompt).toContain('piernas');
  });

  it('los cortes caen EXACTO en cada palabra (ventanas contiguas)', () => {
    expect(out[1]!.endTimeSeconds).toBeCloseTo(out[2]!.startTimeSeconds, 3);
    expect(out[2]!.endTimeSeconds).toBeCloseTo(out[3]!.startTimeSeconds, 3);
    expect(out[3]!.endTimeSeconds).toBeCloseTo(17.926, 2);
  });

  it('re-indexa contiguo y conserva la escena previa', () => {
    expect(out.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(out[0]!.imagePrompt).toBe('CGI lymphatic network');
  });

  it('sin enumeración, devuelve las escenas intactas (no-op)', () => {
    const plain: TimedScene[] = [
      { index: 0, text: 'hola mundo', startTimeSeconds: 0, endTimeSeconds: 2, imagePrompt: 'x' },
    ];
    expect(expandEnumerationScenes(plain, LODO_WORDS.slice(0, 6))).toEqual(plain);
  });
});
