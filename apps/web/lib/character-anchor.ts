// Cap 2 — Anchor de identidad del personaje recurrente.
//
// Genera UNA imagen "ancla" del personaje (una sola vez por run) a partir de su
// descripción (narratorProfile.characterCard). Las escenas que muestran a la
// persona la usan como referencia de IDENTIDAD (image-to-image) para mantener la
// MISMA persona en todo el video. Antes esto se hacía a mano; ahora vive en el
// código del pipeline.

import { GeminiImageProvider } from '@video-factory/block-image-gen-imagen';

export interface CharacterAnchorOptions {
  characterDescription: string;
  ageRange?: string;
  styleBase?: string;
  apiKey: string;
}

export async function generateCharacterAnchor(opts: CharacterAnchorOptions): Promise<Buffer> {
  const provider = new GeminiImageProvider({ apiKey: opts.apiKey, name: 'gemini-image-anchor' });
  const age = opts.ageRange ? ` (around ${opts.ageRange} years old)` : '';
  const style = opts.styleBase ? `${opts.styleBase}. ` : '';
  const prompt =
    `${style}Photorealistic vertical 9:16 portrait of ${opts.characterDescription}${age}. ` +
    'Clear, well-lit, front-facing, neutral friendly expression, plain simple background. ' +
    'This is the canonical identity reference for the recurring character. ' +
    'No text, no captions, no watermark.';
  return provider.generate({ prompt, aspectRatio: '9:16' });
}
