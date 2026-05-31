import { describe, expect, it } from 'vitest';
import { preferredProviderOrder } from '../src/block.js';

const LABELS = ['google:imagen-4', 'gemini:nano-banana-ref', 'higgsfield:flux-pro'];

describe('preferredProviderOrder (cap 1 — ruteo por componente)', () => {
  it('cgi-macro prefiere Nano Banana/Gemini', () => {
    expect(preferredProviderOrder(LABELS, 'cgi-macro')[0]).toBe(1);
  });

  it('real-ugc-human prefiere Higgsfield/Flux', () => {
    expect(preferredProviderOrder(LABELS, 'real-ugc-human')[0]).toBe(2);
  });

  it('overlay-on-body prefiere Nano Banana', () => {
    expect(preferredProviderOrder(LABELS, 'overlay-on-body')[0]).toBe(1);
  });

  it('other / undefined NO reordena (orden identidad)', () => {
    expect(preferredProviderOrder(LABELS, 'other')).toEqual([0, 1, 2]);
    expect(preferredProviderOrder(LABELS, undefined)).toEqual([0, 1, 2]);
  });

  it('preserva TODOS los índices (el fallback queda intacto)', () => {
    const order = preferredProviderOrder(LABELS, 'real-ugc-human');
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});
