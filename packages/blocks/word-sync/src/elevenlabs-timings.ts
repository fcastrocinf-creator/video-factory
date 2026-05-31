// Cliente del endpoint ElevenLabs `/with-timestamps`: devuelve el audio + la
// alineación por carácter, de la que derivamos palabras cronometradas.
//
// IMPORTANTE: el audio devuelto y los timestamps corresponden a ESTA generación
// concreta. Hay que usar ESE audio como pista final (no regenerar aparte) para
// que los cortes calcen.

import type { CharAlignment, WordTiming } from './types.js';
import { tokenizeFromAlignment } from './micro-scenes.js';

export interface FetchWordTimingsOptions {
  text: string;
  voiceId: string;
  apiKey: string;
  modelId?: string;
  voiceSettings?: Record<string, unknown>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WordTimingsResult {
  /** MP3 de la voz (el mismo al que corresponden los timestamps). */
  audio: Buffer;
  words: WordTiming[];
  alignment: CharAlignment;
}

export async function fetchWordTimings(opts: FetchWordTimingsOptions): Promise<WordTimingsResult> {
  const base = opts.baseUrl ?? 'https://api.elevenlabs.io/v1';
  const f = opts.fetchImpl ?? fetch;
  const resp = await f(`${base}/text-to-speech/${encodeURIComponent(opts.voiceId)}/with-timestamps`, {
    method: 'POST',
    headers: {
      'xi-api-key': opts.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: opts.modelId ?? 'eleven_multilingual_v2',
      voice_settings: opts.voiceSettings,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ElevenLabs with-timestamps ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    audio_base64: string;
    alignment?: CharAlignment;
    normalized_alignment?: CharAlignment;
  };
  const alignment = data.alignment ?? data.normalized_alignment;
  if (!alignment) throw new Error('ElevenLabs with-timestamps: respuesta sin alignment');
  return {
    audio: Buffer.from(data.audio_base64, 'base64'),
    words: tokenizeFromAlignment(alignment),
    alignment,
  };
}
