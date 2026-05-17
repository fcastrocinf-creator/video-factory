import type { SubtitleLine, SubtitleWord } from '@video-factory/contracts';

const DEFAULT_MAX_WORDS_PER_LINE = 4;

export interface GroupOptions {
  maxWordsPerLine?: number;
  breakOnSentenceEnd?: boolean;
}

// Misma lógica que subtitles-whisper. Se duplica intencionalmente para mantener la
// regla de "bloques no se conocen entre sí". Si surge una tercera implementación de
// STT, mover este helper a un paquete subtitle-utils compartido.
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
  return /[.?!…]$/.test(token);
}
