// Lógica PURA (sin red) de micro-escenas sincronizadas a la narración.
//
// Idea: cuando el guion enumera cosas ("recorre tu cara, tu abdomen y tus
// piernas"), cada ítem debe tener su propio visual y el corte debe caer EXACTO
// en la palabra. Con los timestamps por palabra (ElevenLabs) detectamos la
// enumeración y devolvemos las ventanas temporales de cada micro-escena.
//
// Esto es lo que en la sesión del LODO se hizo a mano; acá queda codificado y
// testeado para que el tool lo repita solo.

import type { WordTiming, CharAlignment, EnumItem, Enumeration, MicroScene } from './types.js';

const CONNECTORS = new Set(['y', 'e', 'o', 'u']);
const ARTICLES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'mi', 'mis', 'tu', 'tus', 'su', 'sus',
  'nuestro', 'nuestra', 'nuestros', 'nuestras', 'vuestro', 'vuestra',
]);

const PUNCT_RE = /[¿?¡!.,:;"'“”()[\]…]/g;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Quita puntuación y baja a minúsculas (conserva acentos del español). */
export function cleanWord(raw: string): string {
  return raw.toLowerCase().replace(PUNCT_RE, '').trim();
}

function stripPunct(raw: string): string {
  return raw.replace(PUNCT_RE, '').trim();
}

/** Reconstruye palabras + tiempos desde la alineación por carácter de ElevenLabs. */
export function tokenizeFromAlignment(al: CharAlignment): WordTiming[] {
  const chars = al.characters ?? [];
  const st = al.character_start_times_seconds ?? [];
  const en = al.character_end_times_seconds ?? [];
  const words: WordTiming[] = [];
  let cur = '';
  let wStart: number | null = null;
  let wLastEnd = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    if (c === ' ' || c === '\n' || c === '\t') {
      if (cur) {
        words.push({ word: cur, start: round(wStart ?? 0), end: round(wLastEnd) });
        cur = '';
        wStart = null;
      }
    } else {
      if (wStart === null) wStart = st[i] ?? 0;
      cur += c;
      wLastEnd = en[i] ?? wLastEnd;
    }
  }
  if (cur) words.push({ word: cur, start: round(wStart ?? 0), end: round(wLastEnd) });
  return words;
}

interface Segment {
  words: WordTiming[];
  sepAfter: 'comma' | 'connector' | 'end';
}

/** Parte el stream de palabras en segmentos por comas, conectores y fin de oración. */
function splitSegments(words: WordTiming[]): Segment[] {
  const segs: Segment[] = [];
  let buf: WordTiming[] = [];
  for (const w of words) {
    const c = cleanWord(w.word);
    const endsComma = /,\s*$/.test(w.word);
    const endsSentence = /[.:;?!]\s*$/.test(w.word);
    const isConnector = CONNECTORS.has(c) && buf.length > 0;
    if (isConnector) {
      segs.push({ words: buf, sepAfter: 'connector' });
      buf = [];
      continue; // el conector es separador, no forma parte del ítem
    }
    buf.push(w);
    if (endsComma) {
      segs.push({ words: buf, sepAfter: 'comma' });
      buf = [];
    } else if (endsSentence) {
      segs.push({ words: buf, sepAfter: 'end' });
      buf = [];
    }
  }
  if (buf.length) segs.push({ words: buf, sepAfter: 'end' });
  return segs;
}

/** Convierte un segmento en un ítem de enumeración, o null si no califica. */
function toItem(seg: Segment, maxWords: number): EnumItem | null {
  const words = seg.words;
  if (words.length === 0) return null;

  // Recorta el lead-in (ej. el verbo "recorre") hasta el primer artículo.
  let startLocal = 0;
  const firstArticleIdx = words.findIndex((w) => ARTICLES.has(cleanWord(w.word)));
  const hadArticle = firstArticleIdx >= 0;
  if (firstArticleIdx > 0) startLocal = firstArticleIdx;

  const phraseWords = words.slice(startLocal);
  if (phraseWords.length === 0 || phraseWords.length > maxWords) return null;

  const anchorWord = phraseWords[phraseWords.length - 1]!;
  const anchor = cleanWord(anchorWord.word);
  if (!anchor) return null;

  return {
    phrase: phraseWords.map((w) => stripPunct(w.word)).join(' '),
    anchor,
    start: phraseWords[0]!.start,
    end: anchorWord.end,
    hadArticle,
    singleWord: phraseWords.length === 1,
    leadInWords: words.slice(0, startLocal),
  };
}

export interface DetectOptions {
  /** Mínimo de ítems para considerar enumeración (default 2). */
  minItems?: number;
  /** Máximo de palabras por ítem tras recortar lead-in (default 3). */
  maxWordsPerItem?: number;
}

/**
 * Detecta enumeraciones ("A, B y C") en el stream de palabras.
 * Filtra falsos positivos exigiendo PARALELISMO: o todos los ítems arrancan con
 * artículo (tu cara / tu abdomen / tus piernas) o todos son sustantivos pelados
 * (manzanas, peras, uvas).
 */
export function detectEnumerations(words: WordTiming[], opts: DetectOptions = {}): Enumeration[] {
  const minItems = opts.minItems ?? 2;
  const maxWords = opts.maxWordsPerItem ?? 3;
  const segs = splitSegments(words);
  const enums: Enumeration[] = [];

  let run: Segment[] = [];
  const flush = () => {
    if (run.length >= minItems) {
      const linkSeps = run.slice(0, -1).map((s) => s.sepAfter);
      const hasConnector = linkSeps.includes('connector');
      const commaCount = linkSeps.filter((s) => s === 'comma').length;
      if (hasConnector || commaCount >= 1) {
        const items = run.map((s) => toItem(s, maxWords));
        if (items.every((it): it is EnumItem => it !== null)) {
          const valid = items as EnumItem[];
          const allArticle = valid.every((it) => it.hadArticle);
          const allSingle = valid.every((it) => it.singleWord);
          const anchors = new Set(valid.map((it) => it.anchor));
          if ((allArticle || allSingle) && anchors.size === valid.length) {
            enums.push({
              items: valid,
              start: valid[0]!.start,
              end: valid[valid.length - 1]!.end,
            });
          }
        }
      }
    }
    run = [];
  };

  for (const seg of segs) {
    run.push(seg);
    if (seg.sepAfter === 'end') flush();
  }
  flush();
  return enums;
}

/**
 * Planifica micro-escenas a partir de las palabras cronometradas. Cada ítem de
 * cada enumeración se convierte en una ventana [start, end) donde end = inicio
 * del siguiente ítem (para que el corte calce con la narración).
 */
export function planMicroScenes(words: WordTiming[], opts: DetectOptions = {}): MicroScene[] {
  const enums = detectEnumerations(words, opts);
  const scenes: MicroScene[] = [];
  for (const e of enums) {
    for (let i = 0; i < e.items.length; i++) {
      const it = e.items[i]!;
      const end = i < e.items.length - 1 ? e.items[i + 1]!.start : it.end;
      scenes.push({
        item: it.phrase,
        anchor: it.anchor,
        start: round(it.start),
        end: round(end),
        enumerationStart: round(e.start),
      });
    }
  }
  return scenes;
}

/**
 * Devuelve el tiempo de fin (segundos) de la primera/ N-ésima aparición de una
 * palabra. Útil para cortar visuales sincronizados a una palabra puntual.
 */
export function findWordTime(
  words: WordTiming[],
  target: string,
  occurrence = 1,
): WordTiming | null {
  const t = cleanWord(target);
  let seen = 0;
  for (const w of words) {
    if (cleanWord(w.word) === t) {
      seen++;
      if (seen === occurrence) return w;
    }
  }
  return null;
}
