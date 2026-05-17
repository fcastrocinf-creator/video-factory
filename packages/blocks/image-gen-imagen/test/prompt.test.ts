import { describe, expect, it } from 'vitest';
import { buildPrompt, readPngDimensions } from '../src/prompt.js';

describe('buildPrompt', () => {
  it('devuelve el template tal cual si no hay placeholders', () => {
    const t = '3D Pixar style doctor character, white lab coat';
    expect(buildPrompt(t, {})).toBe(t);
  });

  it('sustituye {variable} cuando existe en variables', () => {
    expect(buildPrompt('Hola {nombre}, {saludo}.', { nombre: 'Ana', saludo: 'hola' })).toBe(
      'Hola Ana, hola.',
    );
  });

  it('preserva {variable} sin reemplazar si no está en variables', () => {
    expect(buildPrompt('Hola {nombre}.', {})).toBe('Hola {nombre}.');
  });

  it('reemplaza múltiples ocurrencias de la misma variable', () => {
    expect(buildPrompt('{x} y {x} y {x}', { x: 'A' })).toBe('A y A y A');
  });

  it('soporta caracteres no-ASCII en variables', () => {
    expect(buildPrompt('{ciudad}', { ciudad: 'São Paulo' })).toBe('São Paulo');
  });

  it('matchea sólo caracteres word ASCII en la clave (\\w+ no incluye acentos)', () => {
    // {brandColor} con underscores y dígitos sí matchea.
    expect(buildPrompt('{brand_color_1}', { brand_color_1: '#FFE600' })).toBe('#FFE600');
    // {ciudad-x} con guion NO matchea, se preserva.
    expect(buildPrompt('{ciudad-x}', {})).toBe('{ciudad-x}');
  });
});

describe('readPngDimensions', () => {
  it('lee width y height de un PNG válido', () => {
    // Header PNG sintético: signature + IHDR length + IHDR + width(1080) + height(1920).
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(0x0d0a1a0a, 4);
    buf.writeUInt32BE(13, 8); // IHDR length
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(1080, 16);
    buf.writeUInt32BE(1920, 20);
    expect(readPngDimensions(buf)).toEqual({ width: 1080, height: 1920 });
  });

  it('falla si el buffer es muy chico', () => {
    expect(() => readPngDimensions(Buffer.alloc(10))).toThrow(/demasiado corto/);
  });

  it('falla si la signature no es PNG', () => {
    const buf = Buffer.alloc(24);
    buf.write('NOTAPNG!', 0, 'ascii');
    expect(() => readPngDimensions(buf)).toThrow(/signature incorrecta/);
  });

  it('lee dimensiones grandes (4K vertical)', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(0x0d0a1a0a, 4);
    buf.writeUInt32BE(2160, 16);
    buf.writeUInt32BE(3840, 20);
    expect(readPngDimensions(buf)).toEqual({ width: 2160, height: 3840 });
  });
});
