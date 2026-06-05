import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNeutralSpanish, detectVoseo } from './neutral-es';

test('corrige el voseo REAL del run 787ccbf5 (sentís/entendés)', () => {
  assert.equal(
    toNeutralSpanish('Te sentís hinchada todo el día y no entendés por qué'),
    'Te sientes hinchada todo el día y no entiendes por qué',
  );
});

test('corrige imperativos voseo y "acá" preservando mayúsculas', () => {
  assert.equal(toNeutralSpanish('Mirá esto y vení acá'), 'Mira esto y ven aquí');
  assert.equal(toNeutralSpanish('Acá tenés la solución'), 'Aquí tienes la solución');
});

test('NO toca pretéritos homógrafos válidos en neutro (yo salí, yo sentí)', () => {
  const neutro = 'Ayer yo sentí el sol, salí a correr y elegí quedarme';
  assert.equal(toNeutralSpanish(neutro), neutro);
});

test('NO toca palabras neutras acentuadas (además, después, país, interés)', () => {
  const neutro = 'Además, después del país hubo interés jamás visto';
  assert.equal(toNeutralSpanish(neutro), neutro);
});

test('texto ya neutro queda intacto', () => {
  const neutro = 'Tú vienes aquí, tienes que probar esto y descubres el resultado';
  assert.equal(toNeutralSpanish(neutro), neutro);
});

test('detectVoseo encuentra las formas voseo (para el guardián)', () => {
  const formas = detectVoseo('Te sentís bien, vení acá y probá');
  assert.deepEqual(formas.sort(), ['acá', 'probá', 'sentís', 'vení'].sort());
});

test('detectVoseo no marca texto neutro', () => {
  assert.deepEqual(detectVoseo('Tú vienes aquí y pruebas esto, sin regionalismos'), []);
});
