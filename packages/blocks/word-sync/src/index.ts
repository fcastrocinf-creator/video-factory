// @video-factory/block-word-sync
//
// Sincronización de visuales a la narración + planificación de micro-escenas.
// Capacidad codificada a partir de la sesión del LODO (antes se hacía a mano).
//
// Uso típico en el pipeline:
//   1. fetchWordTimings({ text, voiceId, apiKey }) -> { audio, words }
//   2. planMicroScenes(words) -> ventanas [start,end) por ítem de enumeración
//   3. el compositor corta cada visual en esas ventanas (corte = palabra exacta)

export type {
  WordTiming,
  CharAlignment,
  EnumItem,
  Enumeration,
  MicroScene,
} from './types.js';

export {
  cleanWord,
  tokenizeFromAlignment,
  detectEnumerations,
  planMicroScenes,
  findWordTime,
  type DetectOptions,
} from './micro-scenes.js';

export {
  fetchWordTimings,
  type FetchWordTimingsOptions,
  type WordTimingsResult,
} from './elevenlabs-timings.js';

export { expandEnumerationScenes, type TimedScene } from './scene-expand.js';

export { alignScenesToWords, type AlignableScene } from './scene-align.js';
