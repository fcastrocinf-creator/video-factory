import { describe, expect, it } from 'vitest';
import { buildEditPrompt } from '../src/block.js';

describe('buildEditPrompt (cap 3 — edit/overlay)', () => {
  it('incluye el efecto y la región pedidos', () => {
    const p = buildEditPrompt('glowing amber lymphatic flow', 'abdomen');
    expect(p).toContain('glowing amber lymphatic flow');
    expect(p).toContain('over the abdomen');
  });

  it('bloquea cambios de identidad/pose/encuadre y prohíbe texto', () => {
    const p = buildEditPrompt('cyan glow', 'legs').toLowerCase();
    expect(p).toContain('same person');
    expect(p).toContain('same pose');
    expect(p).toContain('do not change identity');
    expect(p).toContain('text');
  });

  it('sin región no deja "undefined" suelto', () => {
    const p = buildEditPrompt('soft glow');
    expect(p).toContain('soft glow');
    expect(p).not.toContain('undefined');
  });
});
