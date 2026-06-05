// Español neutro: corrección (voseo/regionalismos → "tú") + detección.
// Util COMPARTIDO por el chat IA, el guion del pipeline (antes del TTS) y la
// compuerta de calidad (guardián anti-regresión). Regla DURA del owner: toda
// salida en español neutro, JAMÁS voseo.
//
// Diseño CONSERVADOR a propósito: el mapa solo contiene formas inequívocamente
// voseo/regionales que NO existen en español neutro (acentuadas terminadas en
// -ás/-és/-ís, imperativos voseo acentuados, y "acá"). Es lookup por palabra
// EXACTA (no por patrón), así "además/después/país/jamás/interés" y los
// PRETÉRITOS homógrafos ("yo salí, yo sentí, yo elegí") NUNCA se tocan.
// Quedan FUERA a propósito: "sos" (= sigla SOS) y los imperativos voseo sin
// tilde homógrafos del pretérito (salí/sentí/descubrí), que sin contexto no se
// pueden corregir sin riesgo de romper texto neutro válido.
export const VOSEO_MAP: Record<string, string> = {
  // Imperativos voseo (acentuados, inequívocos)
  mirá: 'mira', hacé: 'haz', vení: 'ven', andá: 'anda', poné: 'pon',
  dejá: 'deja', agregá: 'agrega', probá: 'prueba', fijate: 'fíjate',
  pasá: 'pasa', mandá: 'manda', llevá: 'lleva', traé: 'trae', cerrá: 'cierra',
  acordate: 'acuérdate', quedate: 'quédate', dale: 'vamos',
  // Presente indicativo 2ª persona voseo (-ás/-és/-ís acentuado = inequívoco)
  tenés: 'tienes', querés: 'quieres', podés: 'puedes', hacés: 'haces',
  decís: 'dices', sabés: 'sabes', ponés: 'pones', dejás: 'dejas',
  contás: 'cuentas', usás: 'usas', mirás: 'miras', sentís: 'sientes',
  entendés: 'entiendes', pensás: 'piensas', venís: 'vienes', vivís: 'vives',
  creés: 'crees', comés: 'comes', seguís: 'sigues', salís: 'sales',
  escribís: 'escribes', elegís: 'eliges', abrís: 'abres', necesitás: 'necesitas',
  // Adverbio regional (invariante crítico del owner)
  acá: 'aquí',
};

const WORD_RE = /[A-Za-zÁÉÍÓÚáéíóúñÑ]+/g;

function applyCase(original: string, repl: string): string {
  // Preservar la mayúscula inicial ("Mirá" → "Mira", "Acá" → "Aquí").
  return original[0] === original[0]?.toUpperCase()
    ? repl[0]!.toUpperCase() + repl.slice(1)
    : repl;
}

/** Convierte voseo/regionalismos del texto a español neutro ("tú"). */
export function toNeutralSpanish(text: string): string {
  return text.replace(WORD_RE, (w) => {
    const repl = VOSEO_MAP[w.toLowerCase()];
    return repl ? applyCase(w, repl) : w;
  });
}

/** Devuelve las formas voseo/regionales detectadas (en minúscula, sin repetir).
 *  Lo usa la compuerta como guardián: si quedó alguna, el video NO es neutro. */
export function detectVoseo(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0].toLowerCase();
    if (VOSEO_MAP[w]) found.add(w);
  }
  return [...found];
}
