import { describe, expect, it } from 'vitest';
import { parseScript } from '../src/parser.js';

describe('parseScript', () => {
  it('parsea una oración simple terminada en punto', () => {
    const result = parseScript('Hola mundo.');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.text).toBe('Hola mundo.');
    expect(result.segments[0]?.pauseAfterMs).toBe(200);
  });

  it('detecta U+2026 como pausa de 300ms', () => {
    const result = parseScript('Esto es importante… escucha bien.');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.text).toBe('Esto es importante…');
    expect(result.segments[0]?.pauseAfterMs).toBe(300);
    expect(result.segments[1]?.text).toBe('escucha bien.');
    expect(result.segments[1]?.pauseAfterMs).toBe(200);
  });

  it('detecta ? como pausa de 200ms', () => {
    const result = parseScript('¿Estás listo? Vamos.');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.text).toBe('¿Estás listo?');
    expect(result.segments[0]?.pauseAfterMs).toBe(200);
    expect(result.segments[1]?.pauseAfterMs).toBe(200);
  });

  it('detecta ! como pausa de 200ms', () => {
    const result = parseScript('¡Increíble! Mira esto.');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.pauseAfterMs).toBe(200);
  });

  it('normaliza whitespace múltiple a espacios simples', () => {
    const result = parseScript('  Hola     mundo.   Adiós.  ');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.text).toBe('Hola mundo.');
    expect(result.segments[1]?.text).toBe('Adiós.');
  });

  it('normaliza non-breaking spaces (U+00A0)', () => {
    const result = parseScript('Hola mundo.');
    expect(result.segments[0]?.text).toBe('Hola mundo.');
  });

  it('no divide en comas ni dos puntos', () => {
    const result = parseScript('Mira, mi amigo: esto es reflujo.');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.text).toBe('Mira, mi amigo: esto es reflujo.');
  });

  it('asigna pauseAfterMs 0 cuando no hay puntuación de cierre', () => {
    const result = parseScript('Hola mundo');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.pauseAfterMs).toBe(0);
  });

  it('estima la duración como palabras / 2.5 + pausas', () => {
    // 4 palabras / 2.5 wps = 1.6s + 200ms pausa = 1.8s
    const result = parseScript('Uno dos tres cuatro.');
    expect(result.estimatedDurationSeconds).toBe(1.8);
  });

  it('estima duración acumulando pausas de múltiples segmentos', () => {
    // 6 palabras / 2.5 = 2.4s + 300ms + 200ms = 2.9s
    const result = parseScript('Uno dos tres… cuatro cinco seis.');
    expect(result.estimatedDurationSeconds).toBe(2.9);
  });

  it('respeta el override de wordsPerSecond', () => {
    // 5 palabras / 5 wps = 1s + 200ms = 1.2s
    const result = parseScript('Uno dos tres cuatro cinco.', { wordsPerSecond: 5 });
    expect(result.estimatedDurationSeconds).toBe(1.2);
  });

  it('default language es "es"', () => {
    const result = parseScript('Hola.');
    expect(result.language).toBe('es');
  });

  it('respeta el language override', () => {
    const result = parseScript('Hello.', { language: 'en' });
    expect(result.language).toBe('en');
  });

  it('parsea texto largo del estilo de los videos de referencia', () => {
    const raw =
      'Si no tienes hambre en la mañana, mi amigo, esto es reflujo. ' +
      'Si despiertas a las tres de la mañana ahogándote, esto es reflujo. ' +
      'Si tu voz comienza a enronquecerse sin explicación, esto es reflujo.';
    const result = parseScript(raw);
    expect(result.segments).toHaveLength(3);
    expect(result.segments.every((s) => s.pauseAfterMs === 200)).toBe(true);
  });

  it('cuenta palabras ignorando puntuación', () => {
    // 3 palabras (Hola, mi, amigo) / 2.5 = 1.2s + 200ms = 1.4s
    const result = parseScript('Hola, mi amigo.');
    expect(result.estimatedDurationSeconds).toBe(1.4);
  });

  it('todos los segmentos tienen emphasisWords vacío en MVP', () => {
    const result = parseScript('Una. Dos. Tres.');
    expect(result.segments.every((s) => s.emphasisWords.length === 0)).toBe(true);
  });

  it('preserva caracteres acentuados y ñ', () => {
    const result = parseScript('La España de mañana… acción y razón.');
    expect(result.segments[0]?.text).toBe('La España de mañana…');
    expect(result.segments[1]?.text).toBe('acción y razón.');
  });
});
