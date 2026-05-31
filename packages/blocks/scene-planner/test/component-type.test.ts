import { describe, expect, it } from 'vitest';
import { deriveComponentType } from '../src/block.js';

const idea = (
  imagePrompt: string,
  extra: Partial<{ shotType: string; speaking: boolean }> = {},
) => ({ sceneIndex: 0, text: '', imagePrompt, ...extra });

describe('deriveComponentType (cap 1 — ruteo por componente)', () => {
  it('detecta persona real con prompt en ESPAÑOL (regresión del e2e)', () => {
    expect(
      deriveComponentType(idea('Close-up del rostro de la mujer latina mirándose en el espejo')),
    ).toBe('real-ugc-human');
  });

  it('detecta persona real con prompt en inglés', () => {
    expect(deriveComponentType(idea('close-up of a woman holding a glass of water'))).toBe(
      'real-ugc-human',
    );
  });

  it('CGI macro', () => {
    expect(
      deriveComponentType(idea('hyperreal CGI macro of lymphatic tissue with amber sludge')),
    ).toBe('cgi-macro');
  });

  it('overlay sobre el cuerpo', () => {
    expect(deriveComponentType(idea('woman with glowing lymphatic flow over the legs'))).toBe(
      'overlay-on-body',
    );
  });

  it('animado (Pixar/cartoon) NO es real-ugc-human', () => {
    expect(deriveComponentType(idea('Pixar 3D render of a cartoon woman in a kitchen'))).toBe(
      'other',
    );
  });

  it('escena neutra sin persona', () => {
    expect(deriveComponentType(idea('a plate of sad salad on a kitchen table'))).toBe('other');
  });
});
