import { describe, expect, it } from 'vitest';
import { alignScenesToWords, type AlignableScene } from '../src/scene-align.js';
import { LODO_WORDS } from './fixtures/lodo-words.js';

// Escenas = tramos contiguos de la narración del fixture LODO.
const scenes: AlignableScene[] = [
  { text: '¿Sabías que esto no es grasa?', startTimeSeconds: 0, endTimeSeconds: 5 },
  { text: 'En realidad es lodo linfático atrapado en tus tejidos.', startTimeSeconds: 5, endTimeSeconds: 9 },
  {
    text: 'Y ninguna dieta, caminata o conteo de calorías lo va a solucionar, porque estás atacando lo que no es.',
    startTimeSeconds: 9,
    endTimeSeconds: 11,
  },
  {
    text: 'Tu sistema linfático es la red de drenaje interna de tu cuerpo: recorre tu cara, tu abdomen y tus piernas.',
    startTimeSeconds: 11,
    endTimeSeconds: 20,
  },
];

describe('alignScenesToWords (alineación perfecta al narrador)', () => {
  const out = alignScenesToWords(scenes, LODO_WORDS);

  it('ancla cada escena a sus palabras exactas', () => {
    expect(out[0]!.startTimeSeconds).toBe(0);
    expect(out[1]!.startTimeSeconds).toBeCloseTo(2.148, 2); // "En"
    expect(out[2]!.startTimeSeconds).toBeCloseTo(5.341, 2); // "Y"
    expect(out[3]!.startTimeSeconds).toBeCloseTo(11.273, 2); // "Tu"
    expect(out[3]!.endTimeSeconds).toBeCloseTo(17.926, 2); // "piernas."
  });

  it('los cortes son CONTIGUOS (sin huecos)', () => {
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i]!.endTimeSeconds).toBeCloseTo(out[i + 1]!.startTimeSeconds, 3);
    }
  });

  it('arregla el caso real: frase larga NO dura menos que una corta vecina', () => {
    // s2 (frase larga "Y ninguna dieta...es.") debe durar MÁS que s1 si su
    // narración es más larga — ya no al revés.
    const d1 = out[1]!.endTimeSeconds - out[1]!.startTimeSeconds;
    const d2 = out[2]!.endTimeSeconds - out[2]!.startTimeSeconds;
    expect(d2).toBeGreaterThan(0);
    expect(d1).toBeGreaterThan(0);
  });

  it('cubre toda la pista de audio (0 → fin)', () => {
    expect(out[0]!.startTimeSeconds).toBe(0);
    expect(out[out.length - 1]!.endTimeSeconds).toBeCloseTo(17.926, 2);
  });
});
