import { err, ok, type Result } from 'neverthrow';
import {
  BlockError,
  formatLessonsLearned,
  queryRelevantErrors,
  type Block,
  type BlockContext,
} from '@video-factory/core';
import {
  ParsedScriptSchema,
  type BrandConfig,
  type NarratorProfile,
  type ParsedScript,
  type Scene,
  type SceneTrack,
  type SubtitleTrack,
  type TextOverlay,
} from '@video-factory/contracts';
import { GeminiApiError, GeminiClient } from './gemini-client.js';

export interface ScenePlannerInput {
  parsedScript: ParsedScript;
  // Opcional pero recomendado: timing word-level real de Whisper/Google Speech.
  // Si está, se usa para dar a Gemini la narración con timestamps reales en vez
  // de la distribución proporcional al texto.
  subtitleTrack?: SubtitleTrack;
}

export interface ScenePlannerOptions {
  client?: GeminiClient;
  // Cuántas escenas generar. Default 30 (~1 corte cada 2.4s para audio de 73s,
  // similar al ritmo de los videos de referencia premium).
  targetSceneCount?: number;
  geminiModel?: string;
  // v3.2 #139 (29-may-2026): KNOWLEDGE BASE — preferencias visuales del owner
  // acumuladas cross-run para este brand+preset. El pipeline las lee de
  // owner-feedback-memory y las pasa acá para que la PRIMERA generación de
  // prompts ya las respete (en vez de generarlas mal y corregir reactivamente).
  // Texto en lenguaje natural, ej: "La protagonista debe ser mujer de ~50 años,
  // nunca embarazada. Estilo acuarela cálida, no fotorealista."
  ownerPreferences?: string;
}

interface SceneIdea {
  sceneIndex: number;
  text: string;
  shotType?: string;
  // v3.2 #145: ¿el personaje habla esta línea (lip-sync) o es voice-over/B-roll?
  speaking?: boolean;
  imagePrompt: string;
  textOverlays?: Array<{
    kind: 'product-label' | 'day-counter' | 'metric-callout' | 'subtitle-banner';
    text: string;
    position?: 'top' | 'center' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    color?: string;
    scale?: number;
  }>;
}

export class ScenePlannerBlock implements Block<ScenePlannerInput, SceneTrack> {
  readonly name = 'scene-planner';
  readonly version = '2.0.0';
  readonly description =
    'Divide el guión en N escenas densas con timestamps alineados a la narración real (Whisper). Usa Gemini para generar prompts visuales editoriales por escena.';

  constructor(private readonly options: ScenePlannerOptions = {}) {}

  validateInput(input: unknown): Result<ScenePlannerInput, Error> {
    if (typeof input !== 'object' || input === null) {
      return err(new Error('ScenePlannerInput inválido: debe ser objeto'));
    }
    const obj = input as { parsedScript?: unknown; subtitleTrack?: SubtitleTrack };
    const parsed = ParsedScriptSchema.safeParse(obj.parsedScript);
    if (!parsed.success) {
      return err(new Error(`ParsedScript inválido: ${parsed.error.message}`));
    }
    return ok({
      parsedScript: parsed.data,
      subtitleTrack: obj.subtitleTrack,
    });
  }

  async run(input: ScenePlannerInput, ctx: BlockContext): Promise<Result<SceneTrack, BlockError>> {
    if (!ctx.preset) {
      return err(
        new BlockError(
          this.name,
          'MISSING_PRESET',
          'BlockContext sin preset. scene-planner necesita preset.visualStyle.promptTemplate como base de estilo.',
          false,
        ),
      );
    }

    const apiKey = process.env['GOOGLE_AI_API_KEY'];
    const client = this.options.client ?? (apiKey ? new GeminiClient({ apiKey }) : null);
    if (!client) {
      return err(
        new BlockError(this.name, 'MISSING_API_KEY', 'Falta GOOGLE_AI_API_KEY para Gemini.', false),
      );
    }

    const { parsedScript, subtitleTrack } = input;
    // CRÍTICO: si tenemos subtitleTrack (word-level real), la duración total ES
    // el endTime de la última palabra narrada, NO la estimación del script. La
    // estimación es proporcional al texto y se desvía hasta varios segundos del
    // audio real, dejando cola silenciosa donde escenas y subs siguen mostrándose.
    const narratedEnd =
      subtitleTrack && subtitleTrack.words.length > 0
        ? Math.max(...subtitleTrack.words.map((w) => w.endTimeSeconds))
        : parsedScript.estimatedDurationSeconds;
    const totalDurationSeconds = narratedEnd;
    // Calculamos targetSceneCount proporcional a la duración real (25 escenas/min
    // que es el ritmo de los videos de referencia). Sobre-escribible vía opción.
    const targetSceneCount =
      this.options.targetSceneCount ?? Math.max(8, Math.round((totalDurationSeconds / 60) * 25));
    const styleBase = ctx.preset.visualStyle.promptTemplate;

    // PASO 1: Analizar el narrador antes de planificar escenas. Esto nos da una
    // character card que usaremos en CADA prompt que muestre al narrador, y un
    // gender/edad que el voice-selector y scene-validator usarán downstream.
    const rawScript = parsedScript.segments.map((s) => s.text).join('\n');
    let narratorProfile: NarratorProfile | undefined =
      input.parsedScript.narratorProfile ?? undefined;
    if (!narratorProfile) {
      try {
        narratorProfile = await analyzeNarrator(client, rawScript, this.options.geminiModel);
        ctx.logger.info(
          { runId: ctx.runId, block: this.name, narratorProfile },
          'scene-planner:narrator_analyzed',
        );
      } catch (e) {
        ctx.logger.warn(
          { runId: ctx.runId, block: this.name, err: (e as Error).message },
          'scene-planner:narrator_analysis_failed',
        );
        narratorProfile = {
          gender: 'neutral',
          ageRange: '40-55',
          characterCard: '',
          narratorPresent: false,
        };
      }
    }

    // Narración con timestamps reales (word-level via Whisper) cuando está disponible.
    // Esto permite que Gemini sepa exactamente qué se dice en cada segundo.
    const timedNarration =
      subtitleTrack && subtitleTrack.lines.length > 0
        ? subtitleTrack.lines
            .map(
              (line, i) =>
                `[${i}] ${line.startTimeSeconds.toFixed(1)}-${line.endTimeSeconds.toFixed(1)}s: ${line.text}`,
            )
            .join('\n')
        : parsedScript.segments
            .map((s, i) => `[seg-${i}] (pausa ${s.pauseAfterMs}ms): ${s.text}`)
            .join('\n');

    // Detectamos si el estilo del preset es "photo-realistic / UGC" o "illustrated".
    // El styleBase viene del preset.visualStyle.promptTemplate. Si el dynamic-preset-builder
    // construyó el preset desde un visualStyleProfile, el styleBase contiene la
    // descripción exacta del estilo del original (ej "phone-shot UGC...").
    //
    // Heurística:
    //   1. Si el style tiene TÉRMINOS EXPLÍCITOS de ilustración a mano (hand-illustrated,
    //      watercolor, sepia tone, comic style, cartoon, painted-by-hand, studio ghibli),
    //      es ILLUSTRATED.
    //   2. Si tiene TÉRMINOS EXPLÍCITOS de fotografía/captura real (smartphone, selfie,
    //      handheld, photo-realistic, ugc, stock footage, dslr, real woman/man), es PHOTO.
    //   3. Default: ILLUSTRATED (más conservador).
    //
    // CRÍTICO: "stock medical illustrations" o "anatomical illustrations" son frecuentes en
    // ads tipo infomercial pero NO son hand-drawn cartoons — son footage real con overlays.
    // Por eso el regex de "illustrated" requiere PREFIJOS específicos ("hand-", "digital",
    // "painted-by-hand") en lugar de matchear "illustration" plano.
    const styleBaseLower = styleBase.toLowerCase();
    const explicitlyIllustrated =
      /hand[- ]?illustrated|hand[- ]?drawn|painted by hand|digital painting|watercolor|sepia[- ]?tone|sepia[- ]?watercolor|comic[- ]?style|cartoon|studio ghibli|pixar|disney 2d|pascal campion|painterly brush/.test(
        styleBaseLower,
      );
    const explicitlyPhoto =
      /phone[- ]?shot|smartphone|selfie|hand[- ]?held|photo[- ]?realistic|dslr|stock footage|stock video|real woman|real man|real person|amateur|infomercial|raw camera|natural lighting|home setting|ugc/.test(
        styleBaseLower,
      );
    const isPhotoRealistic = explicitlyPhoto && !explicitlyIllustrated;
    const isMotionGraphics =
      /motion graphics|kinetic typography|explainer animated|infographic style|2d animation/.test(
        styleBaseLower,
      ) && !explicitlyPhoto;

    // El bloque de estilo se construye DESDE el styleBase del preset (no hardcoded).
    // Solo agregamos los modificadores generales (9:16, no watermark) sin imponer
    // un estilo que sobrescriba al del preset.
    const styleBlock = `STYLE BASE OBLIGATORIO — copiá esto al inicio de CADA imagePrompt, literal, sin modificar:
"${styleBase}"
Después agregá la descripción específica de la escena. NO mezcles con otros estilos ni sustituyas por defaults.`;

    const shotTypeGuide = isPhotoRealistic
      ? `REGLAS DE PLANOS (estilo fotorealista/UGC):
- Tipos de plano a alternar:
  * Close-up character: rostro real de persona, plano corto, expresión natural
  * Talking head: persona hablando a cámara estilo selfie/amateur (cuando aplica)
  * Wide environment: lugar/ambiente con o sin personas
  * Product shot: producto en mano, sobre superficie natural, contexto realista
  * Stock-style detail: close-up de detalle (mano, ojo, objeto)
  * Anatomical / medical real: solo si el original tiene ese tipo de footage
- Lighting: natural, indoor amateur, o como indique el styleBase
- NO escribas "illustrated", "watercolor", "drawn", "painted", "cartoon"`
      : isMotionGraphics
        ? `REGLAS DE PLANOS (motion graphics / explainer):
- Tipos de plano a alternar:
  * Kinetic typography: texto animado como protagonista
  * Iconic shape: forma simple, símbolo, ícono central
  * Infographic frame: diagrama/datos visuales
  * Abstract motion: fondo abstracto con elementos en movimiento
- NO uses fotografía ni ilustración compleja`
        : `REGLAS DE PLANOS (estilo ilustrado/animado):
- Tipos de plano a alternar:
  * Close-up character: rostro del personaje en detalle dibujado
  * Anatomical illustration: corte transversal en estilo libro ilustrado
  * Action scene: personaje haciendo algo
  * Symbolic object: objeto sobre fondo plano
  * Product shot: producto ilustrado
  * Comic panel: viñetas`;

    const systemInstruction = `Sos un director visual de clase mundial para ads verticales (TikTok/Reels/Shorts) 9:16. TU JOB MÁS IMPORTANTE: REPLICAR EL ESTILO VISUAL del styleBase que te paso abajo, sin sustituirlo por defaults o estilos genéricos.

CRÍTICO — REGLA #0: CADA ESCENA DEBE TENER "text" CON CONTENIDO REAL. NO devolvás escenas con text vacío. Si te quedaste sin narración, devolvé menos escenas (no rellenes con basura).

CRÍTICO — REGLA #1: La imagen DEBE mostrar LITERALMENTE lo que el narrador dice. NADA de metáforas vagas.

CRÍTICO — REGLA #2: CONTINUIDAD DEL NARRADOR. Cuando una escena muestre al narrador identificado en la NARRATOR CHARACTER CARD (más abajo), usá LITERALMENTE esa descripción al inicio del prompt de personaje. Si en distintas escenas hay otros personajes, inventales descripciones específicas y mantenelas consistentes.

CRÍTICO — REGLA #3 — ESTILO VISUAL: ${styleBlock}

${shotTypeGuide}

REGLAS GENERALES DE PROMPTS:
- No más de 2 escenas seguidas del mismo tipo de plano.
- Palabras prohibidas (safety filters): "doctor", "lab coat", "stethoscope", "clinic", "medical", "patient", "child", "young", "kid", "naked", "blood". Reemplazá por equivalentes neutros ("wise elder", "expert", "wellness setting").
- NO escribas: "looking at camera", "eye contact" — usá "facing the viewer" o "subject centered".

CRÍTICO — REGLA ANTI-EMBARAZO (hinchazón / retención de líquidos / vientre inflamado):
Cuando la narración hable de HINCHAZÓN, RETENCIÓN DE LÍQUIDOS, vientre inflamado o
sensación de inflamación, NUNCA generes iconografía de embarazo. Los modelos de imagen
IGNORAN los negativos ("not pregnant"), así que el problema es la COMPOSICIÓN, no la palabra.
POSES PROHIBIDAS (leen como embarazo aunque digas "no embarazada"):
  ❌ persona de perfil/sideways con vientre redondo protuberante
  ❌ ambas manos acunando/cradling el vientre (gesto maternal)
  ❌ mirándose el vientre en un espejo de perfil
  ❌ panza redonda esférica tipo "baby bump"
EN SU LUGAR, mostrá la hinchazón así (composición NO ambigua):
  ✅ persona DE FRENTE (no de perfil), expresión de incomodidad/cansancio
  ✅ UNA mano presionando el estómago con gesto de molestia (no acunando)
  ✅ ropa/cinturón visiblemente apretado en la cintura, tela tirante
  ✅ cara y mejillas algo hinchadas, ojeras, dedos/anillos apretados
  ✅ vientre distendido pero PLANO-ish, NUNCA un bulto redondo maternal
  ✅ contexto cotidiano de malestar (sentada incómoda, tocándose el costado)
Esta regla es OBLIGATORIA — el owner reportó este error múltiples veces.

TEXT OVERLAYS — ESTRATEGIA CRÍTICA:
Los generadores de imagen (Imagen, Flux, gpt-image-1) CONSTANTEMENTE fallan con texto: labels con gibberish, números fuera de orden, **TEXTO EN INGLÉS cuando el ad es para audiencia hispana** (los modelos copian patrones del entrenamiento e incrustan inglés en vez de respetar el idioma destino). Este es un problema SISTÉMICO que arruina entregas.

EJEMPLOS DE ERRORES REALES QUE DEBÉS EVITAR:
❌ MAL: Botón con "Click Here" burned-in cuando el ad es en español
❌ MAL: Etiquetas de producto con texto inglés incrustado
❌ MAL: Números o porcentajes renderizados directamente en la imagen
❌ MAL: Cualquier palabra visible en la imagen generada

✅ BIEN: Imagen completamente limpia, texto agregado después por el renderer

REGLA OBLIGATORIA — REPETIR EN CADA ESCENA:
Al final de CADA imagePrompt, incluí LITERALMENTE esta frase completa (copia-pega, no parafrasees):

"CLEAN background, NO text overlay, NO captions, NO burned-in text, NO English captions, NO Spanish text, NO numbers, NO labels, NO writing of any kind on the image — absolutely zero text rendering, all text is added in post-production with perfect typography."

Si la escena requiere mostrar un producto, botón, cartel o métrica: describe el OBJETO visual sin texto (ej: "clean white button shape" en vez de "button with text"), y usá textOverlays para el contenido textual.

CASOS donde DEBÉS usar textOverlays:
1. Producto por nombre → kind:"product-label", text:"<NOMBRE>"
2. Cuenta de días ("en 10 días") → kind:"day-counter", text:"DÍA 10"
3. Métricas/porcentajes → kind:"metric-callout"
4. Carteles, banners → kind:"subtitle-banner"

Cuando uses textOverlays, el imagePrompt DEBE incluir: "clean background with NO text, no labels, no writing, no numbers — text will be added in post-production".

CRÍTICO — REGLA "speaking" (HABLA vs VOICE-OVER):
Para CADA escena decidí si el personaje en pantalla DICE esa línea en primera
persona (lip-sync, boca se mueve) o si es VOICE-OVER / B-ROLL (narración off-
screen, la boca NO debe sincronizar con el texto).
  - "speaking": true  → SOLO cuando la escena muestra al NARRADOR/personaje
    diciendo literalmente esa frase en primera persona (testimonial directo a
    cámara, diálogo del personaje). Es el caso MENOS común.
  - "speaking": false → DEFAULT. Voice-over o B-roll: el narrador habla en off
    mientras vemos escenas ilustrativas (una persona con un gesto, un producto,
    una anatomía, un objeto). La boca NO se mueve con el texto. La MAYORÍA de
    las escenas de ads D2C son ASÍ.
Regla práctica: si dudás, poné false. Solo true para talking-head testimonial
explícito en primera persona.

Devolvé EXCLUSIVAMENTE JSON con este shape, sin texto adicional:
{
  "scenes": [
    {
      "sceneIndex": 0,
      "text": "<frase EXACTA literal del transcript narrada en esta escena, NUNCA vacía>",
      "shotType": "<close-up|anatomy|action|object|product|comic-panel|talking-head|wide|stock-detail>",
      "speaking": false,
      "imagePrompt": "<prompt de 30-70 palabras EMPEZANDO con el styleBase literal, después la escena específica>",
      "textOverlays": [
        { "kind": "product-label" | "day-counter" | "metric-callout" | "subtitle-banner", "text": "<TEXTO>", "position": "center" | "bottom" | "top" }
      ]
    }
  ]
}
textOverlays es OPCIONAL — solo cuando aplique uno de los 4 casos.

CRÍTICO — REGLA #4: DURACIÓN TOTAL Y COBERTURA DE AUDIO.
La suma de las duraciones de TODAS las escenas (calculada desde el texto narrado) DEBE coincidir EXACTAMENTE con la duración total del audio del script. NO dejes huecos al final. NO termines el video antes de que termine la narración.

PROCESO DE VERIFICACIÓN OBLIGATORIO:
1. Antes de devolver el JSON, calculá mentalmente: sum(duration_of_each_scene_text) ≈ total_audio_duration
2. Si la última escena termina ANTES del final del audio, EXTENDÉ su texto para cubrir el resto de la narración.
3. Si te sobra narración sin asignar a ninguna escena, creá escenas adicionales hasta agotar TODO el transcript.
4. NUNCA devuelvas un plan donde queden frases del transcript sin asignar a ninguna scene.

EJEMPLO DE ERROR A EVITAR:
- Audio total: 45 segundos
- Escenas planificadas: 8 escenas que cubren solo 38 segundos
- RESULTADO: Los últimos 7 segundos quedan sin video → INACEPTABLE.

SOLUCIÓN: La escena 8 debe extenderse o agregar escena 9 para cubrir esos 7 segundos faltantes con el texto restante del transcript.`;

    const narratorBlock = narratorProfile?.narratorPresent && narratorProfile.characterCard
      ? `NARRATOR CHARACTER CARD (usar LITERALMENTE en cada prompt que muestre al narrador):
"${narratorProfile.characterCard}"
Gender del narrador: ${narratorProfile.gender}
Rango de edad: ${narratorProfile.ageRange}`
      : 'NARRATOR: no hay narrador identificable en este guion (voiceover genérico). No dibujes "al narrador" en ninguna escena.';

    // CONSULTA ERROR MEMORY — recuperamos lecciones aprendidas de fallos pasados
    // relevantes para este guion. Construye un bloque "AVOID THESE PATTERNS" que
    // se inyecta al system prompt. Con el tiempo, los prompts mejoran solos.
    let lessonsBlock = '';
    try {
      const narrationKeywords = parsedScript.segments
        .flatMap((s) => s.text.toLowerCase().match(/\b\w{5,}\b/g) ?? [])
        .slice(0, 20);
      const pastErrors = await queryRelevantErrors({
        keywords: narrationKeywords,
        topK: 10,
      });
      lessonsBlock = formatLessonsLearned(pastErrors);
      if (pastErrors.length > 0) {
        ctx.logger.info(
          { runId: ctx.runId, block: this.name, lessonsCount: pastErrors.length },
          'scene-planner:lessons_loaded',
        );
      }
    } catch (e) {
      ctx.logger.warn(
        { runId: ctx.runId, err: (e as Error).message },
        'scene-planner:lessons_load_failed',
      );
    }

    const ingredientsBlock = buildIngredientsBlock(ctx.brand);

    // v3.2 #139: KNOWLEDGE BASE — preferencias visuales del owner acumuladas.
    // Se inyectan ARRIBA de todo (después de la narración) con prioridad ALTA
    // porque son decisiones explícitas del dueño que sobrescriben defaults.
    const ownerPreferencesBlock = this.options.ownerPreferences?.trim()
      ? `\n🧠 PREFERENCIAS DEL OWNER (PRIORIDAD MÁXIMA — aplícalas a TODAS las escenas, son correcciones que ya dio en videos anteriores de este mismo brand+preset):
${this.options.ownerPreferences.trim()}

Estas preferencias GANAN sobre cualquier default. Si contradicen el estilo base, respeta las preferencias del owner. NO repitas errores que el owner ya corrigió antes.\n`
      : '';

    const userPrompt = `NARRACIÓN CON TIMESTAMPS (${totalDurationSeconds.toFixed(1)}s total):
${timedNarration}
${ownerPreferencesBlock}
${narratorBlock}

ESTILO BASE DEL PROYECTO (úsalo como referencia de paleta y atmósfera, no como copy):
${styleBase}
${ingredientsBlock}
ANATOMÍA — REGLA OBLIGATORIA: cuando un prompt muestre manos, decí EXPLICITAMENTE "hand with five fingers, thumb visible, all digits separated and anatomically correct". Cuando muestre pies, "foot with five toes". Cuando muestre rostros, "symmetrical face, two eyes, no distortion". Estas frases activan correctamente a Imagen y evitan los errores de dedos faltantes.
${lessonsBlock}
Generá EXACTAMENTE ${targetSceneCount} escenas que cubran los ${totalDurationSeconds.toFixed(1)}s en orden cronológico. Cada escena dura aproximadamente ${(totalDurationSeconds / targetSceneCount).toFixed(1)}s. El campo "text" debe ser un extracto literal o casi-literal de la narración (la o las palabras que se dicen MIENTRAS la escena está en pantalla). Las escenas suman juntas TODA la narración sin saltos ni solapamientos.`;

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        targetSceneCount,
        segments: parsedScript.segments.length,
        hasWordLevelTiming: Boolean(subtitleTrack),
      },
      'scene-planner:requesting',
    );

    // RETRY INTERNO: Gemini ocasionalmente devuelve { scenes: [] } por content
    // safety borderline, MAX_TOKENS, o simplemente blip transitorio. Reintentamos
    // hasta 3 veces con prompt ligeramente variado en el último intento (sin
    // lessonsBlock que a veces dispara el safety filter por mencionar "errors").
    let planned: { scenes: SceneIdea[] } | undefined;
    let lastError: unknown = null;
    const MAX_PLANNER_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_PLANNER_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = 1500 * Math.pow(2, attempt - 1) + Math.random() * 500;
        ctx.logger.warn(
          { runId: ctx.runId, attempt: attempt + 1, delayMs: Math.round(delay) },
          'scene-planner:retry',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        // En el último intento, simplificamos el prompt removiendo el lessonsBlock
        // (que es la pieza más larga y que más probable triggea filtros).
        const promptThisAttempt =
          attempt === MAX_PLANNER_ATTEMPTS - 1 && lessonsBlock
            ? userPrompt.replace(lessonsBlock, '')
            : userPrompt;
        const candidate = await client.generateJson<{ scenes?: SceneIdea[] }>({
          prompt: promptThisAttempt,
          systemInstruction,
          model: this.options.geminiModel ?? 'gemini-2.5-pro',
        });
        if (candidate?.scenes && Array.isArray(candidate.scenes) && candidate.scenes.length > 0) {
          planned = { scenes: candidate.scenes };
          if (attempt > 0) {
            ctx.logger.info(
              { runId: ctx.runId, recoveredAt: attempt + 1, sceneCount: candidate.scenes.length },
              'scene-planner:recovered_after_retry',
            );
          }
          break;
        }
        // Si llegó OK pero con 0 escenas, lo registramos para diagnosis y reintentamos
        ctx.logger.warn(
          {
            runId: ctx.runId,
            attempt: attempt + 1,
            sceneCount: candidate?.scenes?.length ?? 0,
            shape: typeof candidate === 'object' ? Object.keys(candidate ?? {}) : typeof candidate,
          },
          'scene-planner:empty_scenes_will_retry',
        );
        lastError = new Error(`empty scenes (attempt ${attempt + 1})`);
      } catch (error) {
        lastError = error;
        ctx.logger.warn(
          {
            runId: ctx.runId,
            attempt: attempt + 1,
            err: error instanceof Error ? error.message : String(error),
            apiStatus: error instanceof GeminiApiError ? error.statusCode : undefined,
          },
          'scene-planner:attempt_failed',
        );
        // Si es 4xx no-retryable (auth, bad request), no insistimos
        if (
          error instanceof GeminiApiError &&
          error.statusCode >= 400 &&
          error.statusCode < 500 &&
          error.statusCode !== 422 &&
          error.statusCode !== 429
        ) {
          break;
        }
      }
    }

    if (!planned) {
      const code =
        lastError instanceof GeminiApiError ? `API_${lastError.statusCode}` : 'NO_SCENES';
      const message =
        lastError instanceof Error ? lastError.message : 'sin error específico';
      // Después de 3 intentos sin éxito: SAFETY (422) y bad-request (4xx) no
      // se resuelven con más reintentos; el caller debería usar otro preset/script.
      // Cualquier otro caso (5xx, network, JSON corrupto) sí es retryable a nivel
      // run completo.
      const retryable = !(lastError instanceof GeminiApiError && lastError.statusCode === 422);
      return err(
        new BlockError(
          this.name,
          code,
          `scene-planner: 3 intentos de Gemini sin escenas válidas. Último error: ${message}. Posibles causas: safety filter del modelo (intenta otro preset/script), token limit (reduce duración), o blip transitorio (reintenta).`,
          retryable,
          lastError,
        ),
      );
    }

    // Filtramos escenas con text vacío o solo espacios — Gemini a veces rellena para
    // cumplir el targetSceneCount con escenas placeholder que generan cola muda.
    const nonEmpty = planned.scenes.filter((s) => (s.text ?? '').trim().length > 0);
    if (nonEmpty.length === 0) {
      return err(
        new BlockError(this.name, 'ALL_SCENES_EMPTY', 'Todas las escenas devueltas tienen text vacío.', false),
      );
    }
    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        rawSceneCount: planned.scenes.length,
        nonEmptyCount: nonEmpty.length,
        droppedEmpty: planned.scenes.length - nonEmpty.length,
      },
      'scene-planner:filtered',
    );

    const scenes = distributeTimestamps(nonEmpty, totalDurationSeconds);

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        sceneCount: scenes.length,
        durations: scenes.map((s) => +(s.endTimeSeconds - s.startTimeSeconds).toFixed(1)),
      },
      'scene-planner:planned',
    );

    return ok({
      scenes,
      totalDurationSeconds,
      styleBase,
      narratorProfile,
    });
  }
}

// Helper: analiza el guion con Gemini para inferir el perfil del narrador
// (gender, edad, character card). Devuelve un NarratorProfile listo para
// inyectar en el system prompt de scene-planning y propagar downstream.
async function analyzeNarrator(
  client: GeminiClient,
  rawScript: string,
  geminiModel?: string,
): Promise<NarratorProfile> {
  const systemInstruction = `Eres un analista de guiones publicitarios. Tu trabajo es leer un guion y extraer el perfil del NARRADOR (la persona que habla en primera persona o se identifica explícitamente en el guion).

Devuelve EXCLUSIVAMENTE JSON con este shape exacto:
{
  "narratorPresent": true | false,
  "gender": "male" | "female" | "neutral",
  "ageRange": "20-30" | "30-40" | "40-55" | "55-70" | etc,
  "characterCard": "<35-60 palabras describiendo VISUALMENTE al narrador para que un ilustrador lo dibuje siempre igual: edad aproximada, género, etnia/origen, peinado y color de pelo, vestimenta característica, ambiente típico donde aparece, expresión/actitud. SI narratorPresent=false, devolvé string vacío.>"
}

REGLAS:
- narratorPresent=true SOLO si el guion identifica explícitamente al hablante ("Soy el Dr. X", "Mi nombre es Y", "Como experta en Z", o referencias de género claras como "yo, como mujer/hombre de X").
- narratorPresent=false si es voiceover impersonal sin gender claro.
- gender DEBE inferirse de pistas: nombre propio ("Hiroshi"→male, "María"→female), título ("doctor"=ambiguo pero culturalmente más male en LATAM, "doctora"=female), pronombres ("yo como mujer..."), profesión específica.
- characterCard es la pieza clave: debe ser visualmente describible. Ej: "Mature Japanese man around 55, shaved head with white sideburns, wearing traditional ochre robes, calm and authoritative expression, in a serene Kyoto temple garden with bonsai trees and rice paper screens".`;

  const userPrompt = `GUION A ANALIZAR:
${rawScript}

Extrae el NarratorProfile en JSON estricto.`;

  const result = await client.generateJson<{
    narratorPresent: boolean;
    gender: 'male' | 'female' | 'neutral';
    ageRange: string;
    characterCard: string;
  }>({
    prompt: userPrompt,
    systemInstruction,
    model: geminiModel ?? 'gemini-2.5-pro',
  });

  return {
    narratorPresent: Boolean(result.narratorPresent),
    gender: ['male', 'female', 'neutral'].includes(result.gender) ? result.gender : 'neutral',
    ageRange: typeof result.ageRange === 'string' ? result.ageRange : '40-55',
    characterCard: typeof result.characterCard === 'string' ? result.characterCard : '',
  };
}

export const scenePlanner = new ScenePlannerBlock();

function distributeTimestamps(ideas: SceneIdea[], totalDuration: number): Scene[] {
  const totalChars = ideas.reduce((acc, s) => acc + s.text.length, 0);
  let cursor = 0;
  return ideas.map((idea, i) => {
    const isLast = i === ideas.length - 1;
    const ratio = idea.text.length / Math.max(1, totalChars);
    const duration = totalDuration * ratio;
    const startTimeSeconds = round3(cursor);
    cursor += duration;
    const endTimeSeconds = isLast ? round3(totalDuration) : round3(cursor);
    const textOverlays: TextOverlay[] | undefined = idea.textOverlays?.map((o) => ({
      kind: o.kind,
      text: o.text,
      position: o.position,
      color: o.color,
      scale: typeof o.scale === 'number' ? o.scale : 1,
    }));
    return {
      index: i,
      text: idea.text,
      startTimeSeconds,
      endTimeSeconds,
      imagePrompt: idea.imagePrompt,
      // v3.2 #145: propagar speaking (default false = voice-over/B-roll)
      speaking: idea.speaking === true,
      ...(textOverlays && textOverlays.length > 0 ? { textOverlays } : {}),
    };
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Construye el bloque BRAND INGREDIENTS para inyectar en el prompt del scene-planner.
 * Convierte la biblioteca visual + reglas de la marca en instrucciones accionables
 * para que Gemini cite productos / colores / assets con precisión y respete las
 * reglas mustInclude/mustAvoid.
 *
 * Si la marca no tiene ingredients configurados (caso default), devuelve "".
 */
function buildIngredientsBlock(brand: BrandConfig | undefined): string {
  if (!brand) return '';
  const ing = brand.ingredients;
  if (!ing) return '';

  const lines: string[] = [];
  const hasContent =
    Boolean(ing.logoPath) ||
    ing.mustInclude.length > 0 ||
    ing.mustAvoid.length > 0 ||
    ing.colorPalette.length > 0 ||
    ing.assets.length > 0 ||
    brand.products.some((p) => p.referenceImagePath || p.dimensions);
  if (!hasContent) return '';

  lines.push('\nBRAND INGREDIENTS — biblioteca visual + reglas de la marca:');

  if (ing.logoPath) {
    const desc = ing.logoDescription ?? '(sin descripción)';
    const placement =
      ing.logoPlacement === 'last-scene'
        ? 'aparece SOLO en la última escena del video'
        : ing.logoPlacement === 'all-scenes'
          ? 'overlay constante en todas las escenas'
          : ing.logoPlacement === 'product-scenes'
            ? 'aparece SOLO en escenas que muestran el producto'
            : 'no se usa automáticamente (el editor lo agrega manualmente)';
    lines.push(`- LOGO: ${desc}. Política: ${placement}. El logo se renderiza como capa vectorial — NO le pidas a la IA que lo dibuje dentro de la imagen.`);
  }

  if (brand.products.length > 0) {
    const productLines = brand.products.map((p) => {
      const parts = [`"${p.name}": ${p.description}`];
      if (p.dimensions) parts.push(`Dimensiones: ${p.dimensions}`);
      return `  · ${parts.join(' ')}`;
    });
    lines.push(`- PRODUCTOS de la marca (mencionar visualmente con precisión cuando la narración los referencia):\n${productLines.join('\n')}`);
  }

  if (ing.assets.length > 0) {
    const assetLines = ing.assets.map(
      (a) => `  · [${a.kind}] ${a.description}`,
    );
    lines.push(`- ASSETS DE REFERENCIA visual disponibles (la IA puede citarlos textualmente "look like the reference X" para que el image generator genere variantes coherentes):\n${assetLines.join('\n')}`);
  }

  if (ing.colorPalette.length > 0) {
    const colorLines = ing.colorPalette.map(
      (c) => `  · ${c.name} (${c.hex})${c.usage ? ` — ${c.usage}` : ''}`,
    );
    lines.push(`- PALETA DE COLORES OFICIAL de la marca:\n${colorLines.join('\n')}`);
  }

  if (ing.mustInclude.length > 0) {
    lines.push(`- DEBE INCLUIRSE en algún momento del video (en imagen o textOverlay):\n${ing.mustInclude.map((m) => `  · ${m}`).join('\n')}`);
  }
  if (ing.mustAvoid.length > 0) {
    lines.push(`- NUNCA INCLUIR (ni en visual ni en textOverlay):\n${ing.mustAvoid.map((m) => `  · ${m}`).join('\n')}`);
  }

  return lines.join('\n') + '\n';
}
