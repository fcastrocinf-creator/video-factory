import { describe, expect, it } from 'vitest';
import { buildIdentityPrompt } from '../src/block.js';

describe('buildIdentityPrompt (cap 2 — identidad)', () => {
  it('mantiene el prompt original y agrega la instrucción de identidad', () => {
    const p = buildIdentityPrompt('A woman drinking water in a kitchen');
    expect(p).toContain('A woman drinking water in a kitchen');
    expect(p.toLowerCase()).toContain('same individual');
    expect(p.toLowerCase()).toContain('same face');
  });

  it('permite cambiar pose/encuadre pero NO la identidad', () => {
    const p = buildIdentityPrompt('x').toLowerCase();
    expect(p).toContain('may change the pose');
    expect(p).toContain('keep the identity identical');
  });
});
