// render-quality-judge.ts — JUEZ Gemini video+audio del RENDER (FASE 2, opt-in).
//
// El panel format-audit hoy solo mira KEYFRAMES estáticos: es ciego a lipsync,
// ritmo de cortes y audio. Este especialista cubre ese hueco mirando el video+audio
// TEMPORAL del render (y opcionalmente el original) vía Gemini 2.5 Pro. Devuelve
// hallazgos en el MISMO formato que SpecialistOutput (deep-audit) para enchufarse
// al panel sin fricción y pasar por el verificador adversarial existente.
//
// Reusa el transporte generalizado (gemini-video-transport) — NO el SYSTEM_INSTRUCTION
// del analista de ad-analyzer (este es un juez nuevo, adversarial). Anti-alucinación:
// la duración exacta del render es un hard constraint y los tiempos se clampean a
// [0, duraciónReal] tras el parse.

import {
  generateContentFromVideos,
  probeVideoDurationSec,
  type GeminiVideoPart,
} from './gemini-video-transport';
import { SpecialistOutputSchema, type SpecialistOutput } from './kb/deep-audit';
import type { Rubric, RubricDimension } from './kb/quality-gate';

export interface RenderQualityJudgeOptions {
  /** OBLIGATORIO: el render a juzgar. */
  renderVideoPath: string;
  /** Opcional: el original de referencia (solo para fidelidad). */
  originalVideoPath?: string;
  /** Narración/guion/claim esperado, para anclar lo que el render debería decir/mostrar. */
  contextText?: string;
  /** Rúbrica: dimensiones activas + severidad de corte. Sin ella, juzga todas. */
  rubric?: Rubric;
}

export const JUDGE_SYSTEM_INSTRUCTION = `Eres un JUEZ FORENSE DE CALIDAD de video publicitario vertical 9:16 (TikTok/Reels) para marcas D2C. Recibes UN video RENDER (la pieza generada que debes juzgar) y, opcionalmente, un SEGUNDO video ORIGINAL de referencia. Tu trabajo: MIRAR y ESCUCHAR el render completo (imagen + audio) y emitir hallazgos ESTRUCTURADOS en JSON.

ORDEN: el PRIMER video es SIEMPRE el RENDER a juzgar. Si hay un SEGUNDO, es el ORIGINAL de referencia (úsalo solo para fidelidad). Nunca juzgues la calidad intrínseca del original.

POSTURA: ADVERSARIAL pero HONESTA. Busca defectos activamente, pero NO inventes fallas que no estén en pantalla ni en el audio. Si algo está bien, no lo reportes. Cada hallazgo se apoya en algo concreto que se ve o se oye, con su marca de tiempo.

IDIOMA: español neutro (formas con "tú"). PROHIBIDO el voseo y los regionalismos (sos/tenés/podés/mirá/dale/acá).

ANCLA TEMPORAL (anti-alucinación): la duración EXACTA del render se te da medida. TODO tiempo DEBE caer dentro de [0, duraciónReal]. Falla global → sin marca de tiempo.

DIMENSIONES (solo las que la rúbrica marque activas):
1. realismo — ¿se ve creíble y NO "de IA"? caras/manos deformes, morphing, texturas plásticas, flicker, "uncanny valley".
2. lipsync — SOLO si hay cabezas que hablan. ¿labios coinciden con audio (fonemas+timing)? Marca el segundo donde se rompe. Las escenas largas suelen empeorarlo.
3. fidelidad-al-original — SOLO si hay ORIGINAL. ¿reproduce el FORMATO (estructura, encuadres, densidad de cortes, captions, ritmo, paleta)? Fidelidad de formato, no copia pixel a pixel.
4. ritmo-cortes — ¿buen pulso vertical (cortes cada ~2-6s en fast-pace)? tramos muertos, cortes mal sincronizados con la narración, escena que se estira.
5. producto-legible — SOLO si vende un producto visible. ¿aparece, integrado (luz/escala/sombra), etiqueta/marca/claim LEGIBLE en móvil?
6. persona-se-ve-bien — en antes/después el "antes" debe verse HINCHADO/inflamado (mejillas/párpados hinchados, papada blanda) con tono SANO y SIN moretones ni ojeras tipo golpe; y MEJORAR progresivamente. FALLA si se ve "golpeada" o sin progresión.
7. recorte-composicion — SOLO si hay recortes/PiP. figura translúcida o con halo/fleco verde, bordes sucios, recorte "pegado", escala/posición antinatural.
8. anotacion-sincronizada — SOLO si hay anotaciones. deben (a) anclarse a la ZONA exacta y (b) aparecer SINCRONIZADAS al momento en que la narración menciona ese rasgo. FALLA si caen en vacío, señalan zona equivocada o van desfasadas.

Devuelve EXCLUSIVAMENTE este JSON (sin markdown):
{"resumen":"...","hallazgos":[{"titulo":"...","severidad":"low|medium|high|critical","descripcion":"qué está mal y en qué segundo","evidencia":"qué se ve/oye que lo prueba","fixPropuesto":"corrección accionable","confianza":0.0-1.0}]}`;

/** Mapa dimensión-de-rúbrica → nombre de dimensión del juez (para el userText). */
const RUBRIC_TO_JUDGE_DIM: Record<RubricDimension, string[]> = {
  'composicion-recorte': ['recorte-composicion'],
  'animacion-movimiento': ['realismo', 'lipsync', 'ritmo-cortes'],
  'voces-diarizacion': ['lipsync'],
  'producto-legibilidad': ['producto-legible'],
  'captions-anotacion': ['anotacion-sincronizada'],
  fidelidad: ['fidelidad-al-original'],
  global: ['persona-se-ve-bien', 'realismo'],
};

function buildUserText(opts: RenderQualityJudgeOptions, realDurationSec: number | null): string {
  const parts: string[] = [];
  parts.push(
    opts.originalVideoPath
      ? 'PRIMER video = RENDER. SEGUNDO = ORIGINAL de referencia (úsalo solo para fidelidad).'
      : 'PRIMER video = RENDER. No hay original; no evalúes fidelidad.',
  );
  if (realDurationSec !== null) {
    parts.push(
      `HARD CONSTRAINT: la duración exacta del RENDER = ${realDurationSec.toFixed(2)}s (medida por ffprobe). TODO tiempo que reportes DEBE caer dentro de [0, ${realDurationSec.toFixed(2)}]. Si quieres escribir un tiempo mayor, estás alucinando; corrige.`,
    );
  }
  if (opts.contextText && opts.contextText.trim()) {
    parts.push(`CONTEXTO (lo que el render debería decir/mostrar):\n"""${opts.contextText.trim()}"""`);
  }
  if (opts.rubric) {
    const dims = new Set<string>();
    for (const c of opts.rubric.criteria) {
      for (const d of RUBRIC_TO_JUDGE_DIM[c.dimension] ?? []) dims.add(d);
    }
    if (dims.size > 0) {
      parts.push(`DIMENSIONES ACTIVAS (juzga SOLO estas): ${[...dims].join(', ')}.`);
    }
    parts.push(serializeRubricCriteriaForJudge(opts.rubric));
  }
  parts.push('Mira y escucha el RENDER completo y devuelve el JSON con los hallazgos.');
  return parts.join('\n\n');
}

function serializeRubricCriteriaForJudge(rubric: Rubric): string {
  const lines = rubric.criteria.map(
    (c) => `  - (corte ${c.failSeverity}) ${c.criterion}`,
  );
  return `CRITERIOS DEL FORMATO (reporta hallazgo SOLO si NO se cumplen):\n${lines.join('\n')}`;
}

/** Extrae el primer bloque JSON del texto (tolerante a prosa/markdown alrededor). */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/**
 * Clampa SOLO marcas temporales EXPLÍCITAS fuera de rango a la duración real.
 *
 * Cuidado (anti-corrupción de evidencia): la versión anterior `(\d+...)\s*s\b`
 * capturaba CUALQUIER "Ns" — y como el `\b` se satisface al final de "ms", "200ms"
 * matcheaba como "200s" y se reescribía a la duración del video (p.ej. "el lipsync
 * se va 200ms" → "20.0s"), destruyendo la evidencia de timing fino justo donde más
 * vale. También pisaba claims tipo "absorbe en 30s".
 *
 * Ahora solo se tocan formas inequívocamente temporales en SEGUNDOS:
 *   - "(N s)" / "(Ns)" entre paréntesis (la forma canónica del prompt),
 *   - "t=Ns",
 *   - "segundo N" / "segundos N",
 *   - un "Ns" suelto NO precedido por 'm' (excluye "ms" = milisegundos).
 */
function clampTimesInText(text: string, maxSec: number): string {
  const clampNum = (num: string): string => {
    const v = parseFloat(num.replace(',', '.'));
    return Number.isFinite(v) && v > maxSec ? maxSec.toFixed(1) : num;
  };
  let out = text;
  // "(N s)" o "(Ns)" entre paréntesis.
  out = out.replace(/\((\d+(?:[.,]\d+)?)\s*s\)/gi, (_w, num: string) => `(${clampNum(num)}s)`);
  // "t=Ns".
  out = out.replace(/\bt\s*=\s*(\d+(?:[.,]\d+)?)\s*s\b/gi, (_w, num: string) => `t=${clampNum(num)}s`);
  // "segundo N" / "segundos N".
  out = out.replace(
    /\b(segundos?)\s+(\d+(?:[.,]\d+)?)/gi,
    (_w, word: string, num: string) => `${word} ${clampNum(num)}`,
  );
  // "Ns" suelto. Capturamos una 'm' opcional ANTES de la 's': si está presente es
  // "ms" (milisegundos) y NO se toca; si no, es segundos y se clampa.
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*(m?)s\b/gi, (whole, num: string, milli: string) => {
    if (milli) return whole; // "Nms" → milisegundos, no es una marca en segundos.
    return `${clampNum(num)}s`;
  });
  return out;
}

/**
 * Juez Gemini video+audio del render. Devuelve SpecialistOutput (mismo formato que
 * los especialistas del panel). Ancla la duración real (anti-alucinación) y clampa
 * los tiempos del texto a [0, duraciónReal] tras el parse tolerante.
 */
export async function renderQualityJudge(
  opts: RenderQualityJudgeOptions,
): Promise<SpecialistOutput> {
  const realDurationSec = await probeVideoDurationSec(opts.renderVideoPath);

  const videos: GeminiVideoPart[] = [
    { videoPath: opts.renderVideoPath, label: 'RENDER' },
  ];
  if (opts.originalVideoPath) {
    videos.push({ videoPath: opts.originalVideoPath, label: 'ORIGINAL' });
  }

  const raw = await generateContentFromVideos({
    videos,
    systemInstruction: JUDGE_SYSTEM_INSTRUCTION,
    userText: buildUserText(opts, realDurationSec),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    // Output ilegible → no rompemos: devolvemos vacío con nota en el resumen.
    return { resumen: 'El juez Gemini devolvió una respuesta no parseable; sin hallazgos.', hallazgos: [] };
  }

  // Parse TOLERANTE (SpecialistOutputSchema trunca/normaliza en vez de rechazar),
  // pero con safeParse: si Gemini devuelve una forma inesperada (hallazgos como
  // objeto, top-level no-objeto como [...] o "texto"), z.object().parse LANZARÍA un
  // ZodError que sube hasta el catch del panel → el veredicto se derivaría SIN los
  // hallazgos del juez (un render malo podría dar 'pass'). Degradamos igual que con
  // el JSON ilegible en vez de tumbar el veredicto.
  const r = SpecialistOutputSchema.safeParse(parsed);
  if (!r.success) {
    return {
      resumen: 'El juez Gemini devolvió un JSON con forma inesperada; sin hallazgos.',
      hallazgos: [],
    };
  }
  const result = r.data;

  // Clamp anti-alucinación de tiempos en el texto de cada hallazgo.
  if (realDurationSec !== null) {
    for (const h of result.hallazgos) {
      h.descripcion = clampTimesInText(h.descripcion, realDurationSec);
      h.evidencia = clampTimesInText(h.evidencia, realDurationSec);
    }
  }
  return result;
}
