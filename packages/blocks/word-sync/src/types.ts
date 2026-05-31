// Tipos para sincronización por palabra + micro-escenas.

/** Una palabra con su ventana temporal en la pista de voz (segundos). */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/**
 * Alineación a nivel carácter que devuelve ElevenLabs `/with-timestamps`.
 * (También sirve `normalized_alignment`.)
 */
export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Un ítem de una enumeración (ej. "tu cara"), con su palabra ancla ("cara"). */
export interface EnumItem {
  /** Frase del ítem ya sin el verbo/lead-in y sin puntuación (ej. "tu cara"). */
  phrase: string;
  /** Palabra ancla = sustantivo que dispara la micro-escena (ej. "cara"). */
  anchor: string;
  start: number;
  end: number;
  /** Si la frase arranca con artículo (tu/la/mi/...). Señal de paralelismo. */
  hadArticle: boolean;
  /** Si el ítem es una sola palabra (sustantivo pelado). */
  singleWord: boolean;
  /** Palabras previas al ítem dentro del segmento (ej. el verbo "recorre"). */
  leadInWords: WordTiming[];
}

/** Una enumeración detectada ("A, B y C") con sus ítems. */
export interface Enumeration {
  items: EnumItem[];
  start: number;
  end: number;
}

/**
 * Una micro-escena: ventana temporal en la que hay que mostrar el visual del
 * `anchor`. El `end` se extiende hasta el inicio del siguiente ítem para que el
 * corte calce exactamente con la narración.
 */
export interface MicroScene {
  item: string;
  anchor: string;
  start: number;
  end: number;
  enumerationStart: number;
}
