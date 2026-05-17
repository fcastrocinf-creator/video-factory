import type { ParsedScript, ScriptSegment } from '@video-factory/contracts';

const DEFAULT_WORDS_PER_SECOND = 2.5;

const PAUSE_MS = {
  ellipsis: 300,
  period: 200,
  question: 200,
  exclamation: 200,
  none: 0,
} as const;

export interface ParseOptions {
  language?: string;
  wordsPerSecond?: number;
}

export function parseScript(rawText: string, options: ParseOptions = {}): ParsedScript {
  const language = options.language ?? 'es';
  const wordsPerSecond = options.wordsPerSecond ?? DEFAULT_WORDS_PER_SECOND;

  const normalized = normalizeWhitespace(rawText);
  const segments = splitIntoSegments(normalized);

  const totalWords = segments.reduce((acc, s) => acc + countWords(s.text), 0);
  const speechSeconds = totalWords / wordsPerSecond;
  const pauseSeconds = segments.reduce((acc, s) => acc + s.pauseAfterMs / 1000, 0);

  return {
    language,
    segments,
    estimatedDurationSeconds: roundTo(speechSeconds + pauseSeconds, 2),
  };
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/ /g, ' ') // non-breaking space → espacio normal
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIntoSegments(text: string): ScriptSegment[] {
  if (text.length === 0) return [];

  // Divide después de cualquier signo de puntuación de cierre de oración (incluido `…` U+2026).
  // El lookbehind preserva el signo como parte del segmento anterior.
  const parts = text.split(/(?<=[.?!…])\s+/);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map<ScriptSegment>((part) => ({
      text: part,
      pauseAfterMs: detectPauseMs(part),
      emphasisWords: [],
    }));
}

function detectPauseMs(segment: string): number {
  if (segment.endsWith('…')) return PAUSE_MS.ellipsis;
  if (segment.endsWith('.')) return PAUSE_MS.period;
  if (segment.endsWith('?')) return PAUSE_MS.question;
  if (segment.endsWith('!')) return PAUSE_MS.exclamation;
  return PAUSE_MS.none;
}

function countWords(text: string): number {
  return text
    .replace(/[.?!…,;:¿¡()«»"]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
