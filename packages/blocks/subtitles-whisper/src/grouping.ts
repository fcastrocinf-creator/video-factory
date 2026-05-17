import type { SubtitleLine, SubtitleWord } from '@video-factory/contracts';

const DEFAULT_MAX_WORDS_PER_LINE = 4;

export interface GroupOptions {
  maxWordsPerLine?: number;
  // Si true, cierra la línea antes del max cuando una palabra termina en puntuación fuerte (. ? ! …).
  breakOnSentenceEnd?: boolean;
}

export function groupWordsIntoLines(
  words: SubtitleWord[],
  options: GroupOptions = {},
): SubtitleLine[] {
  const maxWords = options.maxWordsPerLine ?? DEFAULT_MAX_WORDS_PER_LINE;
  const breakOnSentence = options.breakOnSentenceEnd ?? true;

  if (words.length === 0 || maxWords <= 0) return [];

  const lines: SubtitleLine[] = [];
  let currentWords: SubtitleWord[] = [];
  let currentRefs: number[] = [];

  const flush = () => {
    if (currentWords.length === 0) return;
    const first = currentWords[0]!;
    const last = currentWords[currentWords.length - 1]!;
    lines.push({
      text: currentWords.map((w) => w.word).join(' ').trim(),
      startTimeSeconds: first.startTimeSeconds,
      endTimeSeconds: last.endTimeSeconds,
      wordRefs: [...currentRefs],
    });
    currentWords = [];
    currentRefs = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    currentWords.push(word);
    currentRefs.push(i);

    const reachedMax = currentWords.length >= maxWords;
    const isSentenceEnd = breakOnSentence && endsSentence(word.word);

    if (reachedMax || (isSentenceEnd && currentWords.length >= 2)) {
      flush();
    }
  }

  flush();
  return lines;
}

function endsSentence(token: string): boolean {
  // Whisper a veces devuelve la palabra con puntuación pegada (ej "reflujo.")
  // y a veces no. Detectamos cualquiera de los signos de cierre fuerte.
  return /[.?!…]$/.test(token);
}
