// Scene animator: convierte cada imagen estática de una escena en un clip MP4
// animado usando Veo 3 (image-to-video). Da animación REAL: el personaje
// respira, parpadea, la cámara hace push-in real, los elementos se mueven.
//
// Usa Veo image-to-video con la imagen generada como keyframe. Esto preserva
// composición y character continuity entre escenas. El motion prompt se deriva
// del scene.imagePrompt para que la animación sea coherente con la escena.
//
// Concurrencia: Veo Lite tarda ~30-90s por clip. Con concurrency=4 paralelos,
// 30 escenas tardan ~5-15 min. Costo: ~$0.10-0.40 por clip = ~$3-12 por video.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Scene, SceneTrack } from '@video-factory/contracts';
import {
  KlingClient,
  type KlingModel,
  VeoClient,
  type VeoModel,
  HiggsfieldVideoClient,
  type HiggsfieldVideoModel,
} from '@video-factory/block-video-gen-veo';
import {
  runValidatorLoop,
  VALIDATOR_NAME,
  type ValidatorBrandContext,
  type ValidatorPrevScene,
  type ValidatorHistoryEntry,
} from './validator-chat-ia';

// Logger mínimo compatible con pino — usamos shape duck-typed para evitar la
// dependencia directa (pino no está en deps de web; el caller pasa el suyo).
interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface AnimateScenesOptions {
  sceneTrack: SceneTrack;
  workDir: string;
  // Veo API key (AI Studio o Vertex) — usado SOLO como fallback si Kling falla.
  veoApiKey: string;
  // Kling credentials — si están seteadas, Kling es PRIMARY para B-ROLL animado
  // (Pixar, acuarela, comic). Si no están, se usa Veo directo.
  klingAccessKey?: string;
  klingSecretKey?: string;
  klingModel?: KlingModel;
  klingMode?: 'std' | 'pro';
  klingDuration?: '5' | '10';
  // 25-may-2026: Higgsfield credentials para image-to-video. Si están seteadas Y
  // preferHiggsfield=true, Higgsfield es PRIMARY (mejor realismo facial para UGC/
  // personas reales). Decisión owner: UGC/realistas → Higgsfield, animados → Kling.
  higgsfieldKeyId?: string;
  higgsfieldKeySecret?: string;
  higgsfieldModel?: HiggsfieldVideoModel;
  // Si true, intentar Higgsfield primero (para presets UGC/realistas). Kling es
  // fallback. Si false (default), comportamiento legacy: Kling primary, Veo fallback.
  preferHiggsfield?: boolean;
  concurrency?: number;
  model?: VeoModel;
  durationSeconds?: number;
  skipMissingImages?: boolean;
  // v3.2 #135: scenes que vienen de un fork (con .png + .mp4 ya en disco).
  // El animator las salta totalmente: no anima, no llama a VALIDATOR, no pausa
  // para owner. Quedan como "pre-aprobadas" en sceneTrack listo para compositor.
  preApprovedSceneIndices?: Set<number>;
  // v3.2 #142: estilos ilustrados (acuarela/sepia/comic). Cuando true, NO se
  // llama a Kling/Veo/Higgsfield (que se desvían de la imagen base y producen
  // clips que no coinciden con la estática). El animator SIGUE corriendo el
  // VALIDATOR sobre la imagen estática + la pausa colaborativa, pero deja la
  // scene SIN videoPath → el compositor le aplica Ken Burns fiel a la estática.
  skipVideoGen?: boolean;
  logger?: MinimalLogger;
  onProgress?: (done: number, total: number, currentSceneIndex?: number) => void;
  // ────────────────────────────────────────────────────────────────────────
  // VALIDATOR CHAT IA wiring (27-may-2026)
  // ────────────────────────────────────────────────────────────────────────
  // Si `validator` está habilitado, después de animar CADA escena llamamos al
  // VALIDATOR CHAT IA con la imagen estática + 3 keyframes del clip. Si verdict
  // ='wrong', el validator intenta re-animar (o pide regenerar imagen) hasta
  // `maxAttempts`. Si pasados los retries sigue mal, marcamos la scene con
  // `validatorRejected=true` y persistimos motivo, pero NO bloqueamos el pipeline.
  /** v3.2 #115: si 'collaborative', el animator pausa después de cada scene
   *  (concurrency=1 forzado) esperando aprobación del owner via UI. */
  mode?: 'auto' | 'collaborative';
  validator?: {
    enabled: boolean;
    runId: string;
    maxAttempts?: number;
    brandContext?: ValidatorBrandContext;
    /** Resumen del script completo (concatenación de narraciones, max 2000 chars). */
    scriptFullSummary?: string;
    /** Total de escenas (para contexto). */
    totalScenes?: number;
    /** Callback para regenerar el PNG cuando VALIDATOR pide correctedImagePrompt. */
    onRegenerateImage?: (args: {
      scene: Scene;
      correctedImagePrompt: string;
      attempt: number;
    }) => Promise<{ updatedScene: Scene; newStaticImagePath: string }>;
    /**
     * v2: callback al scene-patch-tracker. Cuando VALIDATOR rechaza una scene
     * y propone un systemicAntiPattern, lo reportamos al tracker para que si
     * 2+ scenes del MISMO run reportan el mismo patrón, se persista como
     * propuesta pendiente para el cerebro evolutivo cross-run.
     */
    onAntiPatternDetected?: (info: {
      sceneIndex: number;
      pattern: string;
      severity: 'minor' | 'major' | 'critical';
      category: string;
      description: string;
    }) => void;
    /** Opcional model override (default 'claude-sonnet-4-5'). */
    model?: string;
    /** Opcional api key override. */
    apiKey?: string;
  };
  /** Callback que recibe el verdict por scene (UI puede mostrar progreso). */
  onSceneValidated?: (info: {
    sceneIndex: number;
    passed: boolean;
    attempts: number;
    historyEntries: ValidatorHistoryEntry[];
  }) => void;
}

/**
 * Genera un motion prompt DINÁMICO según el tipo de scene (shotType + narrativeBeat).
 *
 * v2 (27-may-2026): basado en análisis profundo del SOOMI (storage/probe/soomi-deep-analysis.json)
 * para hacer animaciones "vivas" tipo story-driven, NO bucle pasivo. Cada tipo
 * de escena (talking-head, anatomy, product-shot, comic-panel, split-screen,
 * action, infographic) recibe un motion prompt específico que activa el tipo
 * de movimiento adecuado para ESA escena en ESE rol narrativo.
 *
 * Filosofía: NUNCA "gallery mode" / "imagen flotando en bucle". SIEMPRE motion
 * que complete una acción implícita en la imagen (mid-gesture → follow-through),
 * camera que avanza la narrativa (push-in al revelar, pull-out al CTA, pan al
 * comparar), lighting que evoluciona con la emoción.
 */
function buildMotionPrompt(scene: Scene): string {
  // v3.2 #143: ya NO inyectamos scene.imagePrompt (re-descripción de contenido)
  // en el motion prompt — eso hacía que Kling re-imaginara la escena y se
  // desviara de la imagen. El motion prompt ahora es PURO movimiento + bloqueo
  // de encuadre. La imagen de entrada es la única fuente de "qué se ve".
  const sceneAny = scene as Scene & {
    shotType?: string;
    narrativeBeat?: string;
    mood?: string;
  };
  const shotType = (sceneAny.shotType ?? '').toLowerCase();
  const narrativeBeat = (sceneAny.narrativeBeat ?? '').toLowerCase();
  const mood = sceneAny.mood ?? '';

  // ════════════════════════════════════════════════════════════════════════
  // v3.2 #144 (29-may-2026): MOTION PROMPT — FORMATO "TRES CAPAS" PROFESIONAL.
  // Reescrito según la metodología de producción real del owner (guías Soomi
  // EsoRepair Pixar). Cada prompt Kling debe ser CONCISO y seguir el patrón:
  //   "[acción sujeto]; [secundario interno/emocional]; sustained [beat];
  //    camera [movimiento editorial sutil]. Three layers: X + Y + camera Z."
  // Por qué funciona: (1) brevedad = Kling no malinterpreta, (2) "sustained"
  // mantiene la escena (anti static-loop Y anti-drift), (3) cámara solo
  // "slow editorial" nunca agresiva (anti re-encuadre), (4) "three layers"
  // le dice a Kling que anime EN paralelo sin re-componer.
  // ════════════════════════════════════════════════════════════════════════
  const moodWord = mood || 'engaged';
  // v3.2 #145: ¿el personaje HABLA esta línea (lip-sync) o es voice-over/B-roll?
  const isSpeaking = Boolean((scene as Scene & { speaking?: boolean }).speaking);
  // capa1 = acción física del sujeto · capa2 = interno/secundario · layersTag = naming
  let layer1: string;
  let layer2: string;
  let camera: string;
  let layersTag: string;
  if (shotType.includes('talking-head') || shotType.includes('close-up')) {
    // v3.2 #145: SOLO mueve la boca si el personaje realmente dice esta línea.
    // En voice-over/B-roll la boca NO sincroniza (se ve raro un personaje
    // moviendo la boca sin que sea su diálogo) — solo expresión y un parpadeo.
    // LIPSYNC: en un primer plano / talking-head, el personaje en pantalla ES el
    // narrador que dice esta línea → su boca SIEMPRE se mueve como hablando (mouth
    // visibly articulating the words), no solo cuando speaking=true. Para animado,
    // boca en movimiento = "está hablando" (lipsync creíble sin phoneme-perfect).
    layer1 =
      'the character on screen is the narrator speaking THIS line: the mouth and jaw clearly OPEN and CLOSE articulating the words throughout the clip (visible talking, not a frozen closed mouth), natural lip movement, a blink, a slight 3° head tilt';
    layer2 = `inner ${moodWord} emotion reads on the face`;
    camera = 'camera slow editorial push-in (2-3% max)';
    layersTag = 'speech + emotion + camera push';
  } else if (shotType.includes('anatomy') || shotType.includes('anatomical') || shotType.includes('diagram')) {
    layer1 = 'highlighted region pulses with a soft glow, gentle directional flow along the pathway';
    layer2 = 'warm healing light grows subtly';
    camera = 'camera slow editorial tracking';
    layersTag = 'region + glow + camera track';
  } else if (shotType.includes('product') || narrativeBeat.includes('product-reveal')) {
    layer1 = 'product holds steady, a soft light glint travels across the surface';
    layer2 = 'gentle warm rim-light builds';
    camera = 'camera slow editorial orbit (very subtle)';
    layersTag = 'product + glint + camera orbit';
  } else if (shotType.includes('split-screen') || shotType.includes('split') || shotType.includes('before-after') || shotType.includes('comparison')) {
    layer1 = 'each panel animates independently, no panel content swaps';
    layer2 = 'before-panel dims slightly while after-panel brightens';
    camera = 'camera stays centered, no movement';
    layersTag = 'panels + contrast + static camera';
  } else if (shotType.includes('comic-panel') || shotType.includes('comic')) {
    layer1 = 'each panel character finishes its gesture, no panel reorders';
    layer2 = 'ambient life in each panel';
    camera = 'camera very slow horizontal editorial pan';
    layersTag = 'panels + gestures + camera pan';
  } else if (shotType.includes('action') || shotType.includes('character-action')) {
    layer1 = 'subject completes the depicted action with natural follow-through, weight shifts';
    layer2 = `${moodWord} body language, hair/clothes settle with gravity`;
    camera = 'camera slow editorial push, subject stays centered';
    layersTag = 'action + body + camera push';
  } else if (shotType.includes('infographic') || shotType.includes('chart') || shotType.includes('map')) {
    layer1 = 'elements settle into place with a soft scale-up, highlighted point pulses';
    layer2 = 'ambient depth';
    camera = 'camera slow editorial push toward the key element';
    layersTag = 'elements + highlight + camera push';
  } else {
    // v3.2 #145: default/genérico. Boca solo si habla; sino, B-roll sin lip-sync.
    layer1 = isSpeaking
      ? 'any visible character speaks this line: lips move in sync with speech, plus a subtle gesture and a blink'
      : 'any visible character is mid-action WITHOUT speaking (voice-over B-roll): mouth neutral/closed, NO lip-sync; just a subtle gesture, a blink, a breath';
    layer2 = `${moodWord} mood reads, subtle parallax between foreground and background`;
    camera = 'camera slow editorial drift (gentle)';
    layersTag = 'subject + ambient + camera drift';
  }

  // Beat narrativo → ajusta la INTENSIDAD del primer layer (sin re-describir contenido)
  let beat = 'sustained presence';
  if (narrativeBeat === 'hook') beat = 'sustained high-energy hook beat from frame 1';
  else if (narrativeBeat === 'problem') beat = 'sustained quiet discomfort';
  else if (narrativeBeat === 'mechanism') beat = 'sustained mechanism in motion';
  else if (narrativeBeat === 'demo') beat = 'sustained meaningful demonstration';
  else if (narrativeBeat === 'product-reveal') beat = 'sustained hero reveal';
  else if (narrativeBeat === 'social-proof') beat = 'sustained genuine warmth';
  else if (narrativeBeat === 'cta') beat = 'sustained inviting call-to-action';

  // FRAMING LOCK condensado (el anti-drift clave, derivado del bug del owner).
  const framingLock =
    'FRAMING LOCK: keep the EXACT framing, crop and subject distance of the input image — if it is full-body stay full-body, if close-up stay close-up; never reframe, never crop to the face, never re-compose. Only animate within this exact picture.';

  // Reglas absolutas condensadas.
  const rules =
    'NO new/removed characters, NO clothing/hair/age changes, NO scene cut, NO text overlay, NO "character sheet" layout. Keep the same composition, palette and style as the input.';

  // Formato final estilo guía Soomi: conciso, 3 capas, sustained, cámara editorial.
  return `Image-to-video: animate the attached image faithfully as the FIRST FRAME. ${layer1}; ${layer2}; ${beat}; ${camera}. Three layers: ${layersTag}. ${framingLock} ${rules}`;
}

/**
 * Anima una escena con routing inteligente:
 *   - Si preferHiggsfield=true Y higgsfield configurado → Higgsfield PRIMARY
 *     (mejor para UGC/personas reales por realismo facial), Kling FALLBACK, Veo LAST
 *   - Si no → Kling PRIMARY (mejor para B-ROLL animado Pixar/acuarela/comic), Veo FALLBACK
 *
 * Si TODOS los providers fallan, devuelve la Scene sin videoPath (Remotion usa imagen estática).
 */
async function animateScene(
  scene: Scene,
  kling: KlingClient | null,
  klingModel: KlingModel,
  klingMode: 'std' | 'pro',
  klingDuration: '5' | '10',
  veo: VeoClient,
  workDir: string,
  durationSeconds: number,
  veoModel: VeoModel,
  higgsfield: HiggsfieldVideoClient | null,
  higgsfieldModel: HiggsfieldVideoModel,
  preferHiggsfield: boolean,
  logger?: MinimalLogger,
  // 27-may-2026: si el VALIDATOR CHAT IA pidió re-animar con un motion prompt
  // específico, lo pasamos acá y ese override gana sobre buildMotionPrompt.
  motionPromptOverride?: string,
  // v3.2 #107 (29-may-2026): cascade real de providers. Cuando VALIDATOR rechaza
  // por static-loop/animation-broken y el animator hizo retries con el MISMO
  // provider, el problema es que el provider está ignorando el prompt. Pasando
  // forcedProvider='veo' (o 'higgsfield' o 'kling') forzamos un provider distinto
  // al que falló. SOLO intenta el forzado — si falla, retorna scene sin video.
  forcedProvider?: 'kling' | 'veo' | 'higgsfield',
): Promise<Scene & { lastProviderUsed?: 'kling' | 'veo' | 'higgsfield' }> {
  if (!scene.imagePath || !existsSync(scene.imagePath)) {
    logger?.warn(
      { sceneIndex: scene.index, imagePath: scene.imagePath },
      'scene-animator:skipping_missing_image',
    );
    return scene;
  }

  const imageBuffer = await readFile(scene.imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const motionPrompt = motionPromptOverride ?? buildMotionPrompt(scene);
  const videoFile = `scene_${String(scene.index).padStart(2, '0')}.mp4`;
  const videoPath = resolve(workDir, videoFile);

  // v3.2 #107: cascade real — si forcedProvider especificado, SOLO intentamos
  // ese provider (saltamos el routing default). Útil cuando VALIDATOR rechazó
  // por motion y queremos forzar un provider distinto al que produjo el clip
  // anterior. Si el forzado falla, retornamos sin clip (Remotion usa estática).
  if (forcedProvider === 'veo') {
    const startVeo = Date.now();
    try {
      const videoBuffer = await veo.generate({
        prompt: motionPrompt,
        imageBase64,
        imageMimeType: 'image/png',
        aspectRatio: '9:16',
        durationSeconds,
        model: veoModel,
      });
      await writeFile(videoPath, videoBuffer);
      logger?.info(
        {
          sceneIndex: scene.index,
          provider: 'veo',
          model: veoModel,
          forced: true,
          bytes: videoBuffer.length,
          elapsedSec: ((Date.now() - startVeo) / 1000).toFixed(1),
        },
        'scene-animator:scene_animated_veo_forced',
      );
      return { ...scene, videoPath, lastProviderUsed: 'veo' };
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, provider: 'veo', forced: true, err: (e as Error).message.slice(0, 200) },
        'scene-animator:veo_forced_failed',
      );
      return { ...scene, lastProviderUsed: 'veo' };
    }
  }
  if (forcedProvider === 'kling' && kling) {
    const startKling = Date.now();
    try {
      const videoBuffer = await kling.generate({
        prompt: motionPrompt,
        imageBase64,
        aspectRatio: '9:16',
        model: klingModel,
        mode: klingMode,
        duration: klingDuration,
      });
      await writeFile(videoPath, videoBuffer);
      logger?.info(
        { sceneIndex: scene.index, provider: 'kling', forced: true },
        'scene-animator:scene_animated_kling_forced',
      );
      return { ...scene, videoPath, lastProviderUsed: 'kling' };
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, provider: 'kling', forced: true, err: (e as Error).message.slice(0, 200) },
        'scene-animator:kling_forced_failed',
      );
      return { ...scene, lastProviderUsed: 'kling' };
    }
  }
  if (forcedProvider === 'higgsfield' && higgsfield) {
    const startHf = Date.now();
    try {
      const videoBuffer = await higgsfield.generate({
        prompt: motionPrompt,
        imageBase64,
        imageMimeType: 'image/png',
        aspectRatio: '9:16',
        durationSec: klingDuration === '10' ? 10 : 5,
        model: higgsfieldModel,
      });
      await writeFile(videoPath, videoBuffer);
      logger?.info(
        { sceneIndex: scene.index, provider: 'higgsfield', forced: true },
        'scene-animator:scene_animated_higgsfield_forced',
      );
      return { ...scene, videoPath, lastProviderUsed: 'higgsfield' };
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, provider: 'higgsfield', forced: true, err: (e as Error).message.slice(0, 200) },
        'scene-animator:higgsfield_forced_failed',
      );
      return { ...scene, lastProviderUsed: 'higgsfield' };
    }
  }

  // M-Higgsfield-routing (25-may-2026): si el preset es UGC/realista, Higgsfield
  // PRIMARY. Su Soul model tiene mejor realismo facial humano que Kling.
  if (preferHiggsfield && higgsfield) {
    const startHf = Date.now();
    try {
      const videoBuffer = await higgsfield.generate({
        prompt: motionPrompt,
        imageBase64,
        imageMimeType: 'image/png',
        aspectRatio: '9:16',
        durationSec: klingDuration === '10' ? 10 : 5,
        model: higgsfieldModel,
      });
      await writeFile(videoPath, videoBuffer);
      logger?.info(
        {
          sceneIndex: scene.index,
          provider: 'higgsfield',
          model: higgsfieldModel,
          bytes: videoBuffer.length,
          elapsedSec: ((Date.now() - startHf) / 1000).toFixed(1),
        },
        'scene-animator:scene_animated_higgsfield',
      );
      return { ...scene, videoPath, lastProviderUsed: 'higgsfield' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger?.warn(
        { sceneIndex: scene.index, provider: 'higgsfield', err: message.slice(0, 200) },
        'scene-animator:higgsfield_failed_trying_kling',
      );
      // sigue a Kling
    }
  }

  // PRIMARY (o fallback de Higgsfield): Kling AI image-to-video
  if (kling) {
    const startKling = Date.now();
    try {
      const videoBuffer = await kling.generate({
        prompt: motionPrompt,
        imageBase64,
        aspectRatio: '9:16',
        model: klingModel,
        mode: klingMode,
        duration: klingDuration,
      });
      await writeFile(videoPath, videoBuffer);
      logger?.info(
        {
          sceneIndex: scene.index,
          provider: 'kling',
          model: klingModel,
          bytes: videoBuffer.length,
          elapsedSec: ((Date.now() - startKling) / 1000).toFixed(1),
        },
        'scene-animator:scene_animated_kling',
      );
      return { ...scene, videoPath, lastProviderUsed: 'kling' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger?.warn(
        { sceneIndex: scene.index, provider: 'kling', err: message.slice(0, 200) },
        'scene-animator:kling_failed_trying_veo',
      );
      // sigue a Veo
    }
  }

  // FALLBACK: Vertex Veo (slower but reliable)
  const startVeo = Date.now();
  try {
    const videoBuffer = await veo.generate({
      prompt: motionPrompt,
      imageBase64,
      imageMimeType: 'image/png',
      aspectRatio: '9:16',
      durationSeconds,
      model: veoModel,
    });
    await writeFile(videoPath, videoBuffer);
    logger?.info(
      {
        sceneIndex: scene.index,
        provider: 'veo',
        bytes: videoBuffer.length,
        elapsedSec: ((Date.now() - startVeo) / 1000).toFixed(1),
      },
      'scene-animator:scene_animated_veo',
    );
    return { ...scene, videoPath, lastProviderUsed: 'veo' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger?.warn(
      { sceneIndex: scene.index, provider: 'veo', err: message.slice(0, 200) },
      'scene-animator:both_failed_keeping_static',
    );
    return scene;
  }
}

/**
 * Anima TODO el SceneTrack en paralelo con concurrencia controlada.
 * Devuelve un SceneTrack nuevo donde cada Scene tiene videoPath setado (si la
 * animación tuvo éxito) o el imagePath original (si falló — fallback graceful).
 */
export async function animateScenes(opts: AnimateScenesOptions): Promise<SceneTrack> {
  const veo = new VeoClient({ apiKey: opts.veoApiKey });
  const kling =
    opts.klingAccessKey && opts.klingSecretKey
      ? new KlingClient({
          accessKey: opts.klingAccessKey,
          secretKey: opts.klingSecretKey,
        })
      : null;
  const klingModel: KlingModel = opts.klingModel ?? 'kling-v2-6';
  const klingMode = opts.klingMode ?? 'std';
  const klingDuration = opts.klingDuration ?? '5';

  // 25-may-2026: Higgsfield video client para UGC/realistas (decisión owner)
  const higgsfield =
    opts.higgsfieldKeyId && opts.higgsfieldKeySecret
      ? new HiggsfieldVideoClient({
          keyId: opts.higgsfieldKeyId,
          keySecret: opts.higgsfieldKeySecret,
        })
      : null;
  const higgsfieldModel: HiggsfieldVideoModel =
    opts.higgsfieldModel ?? 'dop-turbo';
  const preferHiggsfield = opts.preferHiggsfield ?? false;

  // CONCURRENCY 5 CON KLING: el resource pack típico del usuario permite 5
  // tasks paralelos (code 1303 si pasamos). El KlingClient internamente
  // retry-with-backoff cualquier 1303 residual, pero a nivel pool mantenemos
  // 5 para que la mayoría entren directo sin esperar. Sin Kling, Veo permite 4.
  const defaultConcurrency = kling ? 5 : 4;
  const concurrency = Math.max(1, opts.concurrency ?? defaultConcurrency);
  const durationSeconds = opts.durationSeconds ?? 8;
  const veoModel = opts.model ?? 'veo-3.1-lite-generate-preview';

  const total = opts.sceneTrack.scenes.length;
  let done = 0;
  const results: Scene[] = new Array(total);
  const queue = opts.sceneTrack.scenes.map((s, i) => ({ scene: s, originalIdx: i }));

  // v3.2 #107: tracking per-scene del provider usado en el último attempt.
  // Cuando VALIDATOR rechaza por static-loop/animation-broken, sabemos que el
  // provider IGNORÓ el motion prompt → forzamos uno distinto en el siguiente retry.
  const lastProviderPerScene = new Map<number, 'kling' | 'veo' | 'higgsfield'>();

  /**
   * Decide qué provider forzar en un retry, dado el que falló antes.
   * Cascade: Kling → Veo → Higgsfield → Kling (cíclico).
   * Esto cierra el bug que VALIDATOR identificó: si el animator ignora
   * correctedMotionPrompt con el provider X, el retry con MISMO provider X
   * va a producir el MISMO clip.
   */
  function pickNextProvider(
    lastUsed: 'kling' | 'veo' | 'higgsfield' | undefined,
  ): 'kling' | 'veo' | 'higgsfield' {
    if (lastUsed === 'kling') return veo ? 'veo' : higgsfield ? 'higgsfield' : 'kling';
    if (lastUsed === 'veo') return higgsfield ? 'higgsfield' : kling ? 'kling' : 'veo';
    if (lastUsed === 'higgsfield') return kling ? 'kling' : 'veo';
    // Sin info previa: Veo es históricamente el más confiable para motion
    return 'veo';
  }

  // Closure helper para que VALIDATOR pueda RE-ANIMAR usando los mismos
  // clients ya configurados. Devuelve la scene con el nuevo videoPath sobrescrito.
  async function reanimateWithOverride(args: {
    scene: Scene;
    staticImagePath: string;
    correctedMotionPrompt: string;
  }): Promise<{ updatedScene: Scene; newAnimatedVideoPath?: string }> {
    const sceneForRe = { ...args.scene, imagePath: args.staticImagePath };
    const lastUsed = lastProviderPerScene.get(args.scene.index);
    const forcedProvider = pickNextProvider(lastUsed);
    opts.logger?.info(
      {
        sceneIndex: args.scene.index,
        lastProvider: lastUsed,
        forcingProvider: forcedProvider,
        entity: 'VALIDATOR CHAT IA',
      },
      'scene-animator:cascading_to_different_provider_for_motion_retry',
    );
    const animated = await animateScene(
      sceneForRe,
      kling,
      klingModel,
      klingMode,
      klingDuration,
      veo,
      opts.workDir,
      durationSeconds,
      veoModel,
      higgsfield,
      higgsfieldModel,
      preferHiggsfield,
      opts.logger,
      args.correctedMotionPrompt,
      forcedProvider,
    );
    const used = (animated as Scene & { lastProviderUsed?: 'kling' | 'veo' | 'higgsfield' })
      .lastProviderUsed;
    if (used) lastProviderPerScene.set(args.scene.index, used);
    return { updatedScene: animated, newAnimatedVideoPath: animated.videoPath };
  }

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      // v3.2 #135: FORK SKIP — si la scene está pre-aprobada (vino de un fork
      // con .png + .mp4 ya en disco), no la procesamos: solo la dejamos pasar
      // tal cual a results, sin animar, sin VALIDATOR, sin pausa colaborativa.
      // Esto preserva exactamente el trabajo aprobado del run de origen.
      const isPreApproved =
        opts.preApprovedSceneIndices?.has(item.scene.index) &&
        item.scene.imagePath &&
        item.scene.videoPath &&
        existsSync(item.scene.imagePath) &&
        existsSync(item.scene.videoPath);
      if (isPreApproved) {
        opts.logger?.info(
          {
            sceneIndex: item.scene.index,
            entity: 'FORK',
            imagePath: item.scene.imagePath,
            videoPath: item.scene.videoPath,
          },
          'scene-animator:fork_pre_approved_scene_skipping_animation_and_validator',
        );
        results[item.originalIdx] = item.scene;
        done += 1;
        opts.onProgress?.(done, total, item.scene.index);
        continue;
      }

      // v3.2 #142: si skipVideoGen (estilo ilustrado), NO llamamos a los
      // providers de video. La scene pasa sin videoPath → el compositor le
      // aplica Ken Burns sobre la estática (fiel 100%). El VALIDATOR + la
      // pausa colaborativa de abajo SIGUEN corriendo sobre la imagen estática.
      let animated: Scene;
      if (opts.skipVideoGen) {
        animated = item.scene;
        opts.logger?.info(
          { sceneIndex: item.scene.index, entity: 'KEN BURNS' },
          'scene-animator:skip_video_gen_using_ken_burns_on_static',
        );
      } else {
        animated = await animateScene(
          item.scene,
          kling,
          klingModel,
          klingMode,
          klingDuration,
          veo,
          opts.workDir,
          durationSeconds,
          veoModel,
          higgsfield,
          higgsfieldModel,
          preferHiggsfield,
          opts.logger,
        );
        // v3.2 #107: track provider del primer attempt para que retries puedan cascadear
        const firstAttemptProvider = (animated as Scene & {
          lastProviderUsed?: 'kling' | 'veo' | 'higgsfield';
        }).lastProviderUsed;
        if (firstAttemptProvider) lastProviderPerScene.set(item.scene.index, firstAttemptProvider);
      }

      // ────────────────────────────────────────────────────────────────
      // VALIDATOR CHAT IA — gate antes de "incrustarse" en el video
      // ────────────────────────────────────────────────────────────────
      if (opts.validator?.enabled && animated.imagePath) {
        try {
          // ─── v3.2 Live co-pilot: chequear intervenciones del owner ANTES de VALIDATOR ───
          // Si el owner clickeó "Aprobar" o "Skip" para esta scene mientras se
          // animaba, respetamos el override y NO llamamos a VALIDATOR.
          // Si clickeó "Rechazar" con newImagePrompt, regeneramos antes.
          const { readPendingInterventions, markInterventionProcessed } = await import(
            './owner-feedback'
          );
          const pendingForScene = await readPendingInterventions(
            opts.validator.runId,
            animated.index,
          ).catch(() => []);
          let ownerOverrideApplied = false;
          for (const intervention of pendingForScene) {
            if (intervention.type === 'approve' || intervention.type === 'skip') {
              opts.logger?.info(
                {
                  sceneIndex: animated.index,
                  interventionId: intervention.id,
                  type: intervention.type,
                  comment: intervention.comment?.slice(0, 100),
                  entity: 'VALIDATOR CHAT IA',
                },
                'scene-animator:owner_force_approved_scene_skipping_validator',
              );
              await markInterventionProcessed(opts.validator.runId, intervention.id).catch(() => {});
              ownerOverrideApplied = true;
              break;
            }
            if (intervention.type === 'reject') {
              // FIX: regenerar aunque el reject venga SOLO con comentario (sin
              // newImagePrompt). Derivamos el prompt corregido del comentario.
              const correctedPromptA =
                intervention.newImagePrompt ||
                `${animated.imagePrompt}\n\nCORRECCIÓN DEL OWNER (arregla exactamente esto, manteniendo el estilo 3D y el personaje consistente): ${intervention.comment ?? 'la escena no tiene sentido con la narración; rehazla acorde a lo que se dice'}`;
              opts.logger?.info(
                {
                  sceneIndex: animated.index,
                  interventionId: intervention.id,
                  newPromptPreview: correctedPromptA.slice(0, 100),
                  entity: 'VALIDATOR CHAT IA',
                },
                'scene-animator:owner_force_rejected_regenerating',
              );
              if (opts.validator.onRegenerateImage) {
                try {
                  const r = await opts.validator.onRegenerateImage({
                    scene: animated,
                    correctedImagePrompt: correctedPromptA,
                    attempt: 0, // 0 = owner-driven, no cuenta como retry de validator
                  });
                  animated = r.updatedScene;
                  // Re-animar la nueva imagen
                  const reanimated = await animateScene(
                    { ...animated, imagePath: r.newStaticImagePath },
                    kling,
                    klingModel,
                    klingMode,
                    klingDuration,
                    veo,
                    opts.workDir,
                    durationSeconds,
                    veoModel,
                    higgsfield,
                    higgsfieldModel,
                    preferHiggsfield,
                    opts.logger,
                    intervention.newMotionPrompt ?? undefined,
                  );
                  animated = reanimated;
                } catch (e) {
                  opts.logger?.warn(
                    {
                      sceneIndex: animated.index,
                      err: (e as Error).message,
                    },
                    'scene-animator:owner_reject_regen_failed',
                  );
                }
              }
              await markInterventionProcessed(opts.validator.runId, intervention.id).catch(() => {});
              // Después del owner reject + regen, SÍ corremos VALIDATOR sobre el nuevo
              break;
            }
          }

          // Si el owner aprobó manualmente, skip VALIDATOR del todo
          if (ownerOverrideApplied) {
            (animated as Scene & { ownerForceApproved?: boolean }).ownerForceApproved = true;
            results[item.originalIdx] = animated;
            done += 1;
            opts.onProgress?.(done, total, item.scene.index);
            continue;
          }

          // Construimos contexto cross-scene (2 anteriores) usando results parciales
          const prevScenes: ValidatorPrevScene[] = [];
          for (let p = Math.max(0, item.originalIdx - 2); p < item.originalIdx; p++) {
            const ps = opts.sceneTrack.scenes[p];
            if (ps) {
              prevScenes.push({
                index: ps.index,
                visualDescription: (ps.imagePrompt ?? '').slice(0, 200),
                narration: (ps.text ?? '').slice(0, 100),
              });
            }
          }

          const sceneAny = animated as Scene & {
            shotType?: string;
            narrativeBeat?: string;
          };

          const animatedImagePath = animated.imagePath;
          if (!animatedImagePath) {
            // No imagePath after intervention regen — skip validator and accept tal cual
            results[item.originalIdx] = animated;
            done += 1;
            opts.onProgress?.(done, total, item.scene.index);
            continue;
          }
          const loopResult = await runValidatorLoop({
            runId: opts.validator.runId,
            scene: animated,
            staticImagePath: animatedImagePath,
            animatedVideoPath: animated.videoPath,
            brandContext: opts.validator.brandContext,
            prevScenes: prevScenes.length > 0 ? prevScenes : undefined,
            scenePosition: {
              index: animated.index,
              total: opts.validator.totalScenes ?? total,
              narrativeBeat: sceneAny.narrativeBeat,
              shotType: sceneAny.shotType,
            },
            scriptFullSummary: opts.validator.scriptFullSummary,
            maxAttempts: opts.validator.maxAttempts ?? 2,
            model: opts.validator.model,
            apiKey: opts.validator.apiKey,
            logger: opts.logger,
            onReanimate: async ({ scene, staticImagePath, correctedMotionPrompt }) =>
              reanimateWithOverride({ scene, staticImagePath, correctedMotionPrompt }),
            onRegenerateImage: opts.validator.onRegenerateImage,
          });

          animated = loopResult.finalScene;

          // v2: feed cada systemicAntiPattern detectado al scene-patch-tracker
          // para que el cerebro evolutivo aprenda cross-run. Solo enviamos los
          // patterns que VALIDATOR explicitó en cada attempt (no inventamos).
          if (opts.validator.onAntiPatternDetected) {
            for (const entry of loopResult.history) {
              if (
                entry.verdict &&
                entry.verdict.verdict === 'wrong' &&
                entry.verdict.systemicAntiPattern
              ) {
                const firstIssue =
                  entry.verdict.issues.find((i) => i.severity === 'critical') ??
                  entry.verdict.issues[0];
                opts.validator.onAntiPatternDetected({
                  sceneIndex: entry.sceneIndex,
                  pattern: entry.verdict.systemicAntiPattern,
                  severity:
                    (firstIssue?.severity as 'minor' | 'major' | 'critical') ?? 'major',
                  category: firstIssue?.category ?? 'other',
                  description:
                    firstIssue?.description?.slice(0, 200) ??
                    entry.verdict.rationale.slice(0, 200),
                });
              }
            }
          }

          // Si el validator marcó como rechazado, lo flageamos en la scene para
          // que la UI/compositor puedan reaccionar (ej. usar imagen estática y
          // mostrar warning en /runs/[id]).
          if (!loopResult.passed) {
            (animated as Scene & { validatorRejected?: boolean; validatorReason?: string }).validatorRejected = true;
            (animated as Scene & { validatorRejected?: boolean; validatorReason?: string }).validatorReason =
              loopResult.verdict?.rationale ?? 'sin verdict';
            opts.logger?.warn(
              {
                sceneIndex: animated.index,
                attemptsUsed: loopResult.attemptsUsed,
                reason: loopResult.verdict?.rationale?.slice(0, 200),
                entity: VALIDATOR_NAME,
              },
              'scene-animator:validator_chat_ia_rejected_scene',
            );
          } else {
            opts.logger?.info(
              {
                sceneIndex: animated.index,
                attemptsUsed: loopResult.attemptsUsed,
                confidence: loopResult.verdict?.confidence,
                entity: VALIDATOR_NAME,
              },
              'scene-animator:validator_chat_ia_approved_scene',
            );
          }
          opts.onSceneValidated?.({
            sceneIndex: animated.index,
            passed: loopResult.passed,
            attempts: loopResult.attemptsUsed,
            historyEntries: loopResult.history,
          });
        } catch (e) {
          opts.logger?.warn(
            {
              sceneIndex: animated.index,
              err: (e as Error).message,
              entity: VALIDATOR_NAME,
            },
            'scene-animator:validator_chat_ia_threw_continuing_with_unvalidated_scene',
          );
        }
      }

      // ─── v3.2 #133 (29-may-2026): GUARD MP4 ↔ PNG CONSISTENCY ─────
      // Si el VALIDATOR regeneró la imagen pero la re-animación falló (por
      // ejemplo VALIDATOR posterior dio API 413 y abortó), el .png en disco
      // queda más nuevo que el .mp4 → el owner ve estática + video que NO
      // corresponde. Detectamos por mtime y forzamos UNA re-animación con
      // motion prompt genérico antes de pausar para approve.
      try {
        const imgPath = animated.imagePath;
        const vidPath = animated.videoPath;
        if (imgPath && existsSync(imgPath) && vidPath && existsSync(vidPath)) {
          const { stat } = await import('node:fs/promises');
          const imgStat = await stat(imgPath);
          const vidStat = await stat(vidPath);
          // 1 segundo de margen para no disparar por jitter del filesystem
          if (imgStat.mtimeMs > vidStat.mtimeMs + 1000) {
            opts.logger?.warn(
              {
                sceneIndex: animated.index,
                imgMtime: imgStat.mtime.toISOString(),
                vidMtime: vidStat.mtime.toISOString(),
                gapSec: ((imgStat.mtimeMs - vidStat.mtimeMs) / 1000).toFixed(1),
                entity: 'CONSISTENCY GUARD',
              },
              'scene-animator:png_newer_than_mp4_re_animating',
            );
            try {
              const r = await reanimateWithOverride({
                scene: animated,
                staticImagePath: imgPath,
                correctedMotionPrompt:
                  'character mid-action coherent with the static image, subtle camera push-in 4% over 8s, natural breathing and blinking, micro head tilt, no sudden cuts',
              });
              animated = r.updatedScene;
              opts.logger?.info(
                { sceneIndex: animated.index, entity: 'CONSISTENCY GUARD' },
                'scene-animator:consistency_re_animation_succeeded',
              );
            } catch (reanimErr) {
              opts.logger?.warn(
                {
                  sceneIndex: animated.index,
                  err: (reanimErr as Error).message,
                  entity: 'CONSISTENCY GUARD',
                },
                'scene-animator:consistency_re_animation_failed_keeping_stale',
              );
            }
          }
        }
      } catch (guardErr) {
        opts.logger?.warn(
          {
            sceneIndex: animated.index,
            err: (guardErr as Error).message,
            entity: 'CONSISTENCY GUARD',
          },
          'scene-animator:consistency_guard_threw',
        );
      }

      // ─── v3.2 #116: PAUSA COLABORATIVA ────────────────────────────
      // Si mode=collaborative, pausamos acá esperando al owner. El loop de
      // polling lee la DB cada 5s para chequear si el owner clickeó algún
      // botón. Si lo hizo:
      //   - approve → continuar normal con la scene tal cual
      //   - reject  → regenerar con newImagePrompt opcional
      //   - skip    → aceptar tal cual sin re-evaluar
      // En mode=auto, esto retorna inmediato sin esperar.
      if (opts.mode === 'collaborative' && opts.validator?.runId) {
        try {
          const { waitForApprovalIfCollaborative } = await import('./collaborative-mode');
          const approval = await waitForApprovalIfCollaborative({
            runId: opts.validator.runId,
            sceneIndex: animated.index,
            logger: opts.logger,
          });
          opts.logger?.info(
            {
              sceneIndex: animated.index,
              action: approval.action,
              waitedSec: (approval.waitedMs / 1000).toFixed(1),
              extraComments: approval.additionalComments.length,
              entity: 'COLLABORATIVE MODE',
            },
            'scene-animator:collaborative_resumed',
          );
          if (approval.action === 'reject' && opts.validator.onRegenerateImage) {
            // FIX: regenerar SIEMPRE en reject, aunque el owner solo dejó un COMENTARIO
            // (sin newImagePrompt). Derivamos el prompt corregido del comentario + el
            // prompt original, así "Rechazar y regenerar" SÍ regenera la escena.
            const correctedPrompt =
              approval.newImagePrompt ||
              `${animated.imagePrompt}\n\nCORRECCIÓN DEL OWNER (arregla exactamente esto, manteniendo el estilo 3D y el personaje consistente): ${approval.intervention?.comment ?? 'la escena no tiene sentido con la narración; rehazla acorde a lo que se dice en este momento'}`;
            try {
              const r = await opts.validator.onRegenerateImage({
                scene: animated,
                correctedImagePrompt: correctedPrompt,
                attempt: 0,
              });
              animated = r.updatedScene;
              const reanimated = await animateScene(
                { ...animated, imagePath: r.newStaticImagePath },
                kling,
                klingModel,
                klingMode,
                klingDuration,
                veo,
                opts.workDir,
                durationSeconds,
                veoModel,
                higgsfield,
                higgsfieldModel,
                preferHiggsfield,
                opts.logger,
                approval.newMotionPrompt ?? undefined,
              );
              animated = reanimated;
            } catch (e) {
              opts.logger?.warn(
                { sceneIndex: animated.index, err: (e as Error).message },
                'scene-animator:collaborative_reject_regen_failed',
              );
            }
          } else if (approval.action === 'timeout') {
            opts.logger?.warn(
              { sceneIndex: animated.index, entity: 'COLLABORATIVE MODE' },
              'scene-animator:collaborative_timeout',
            );
            // v3.3 fix-consent: en timeout NO aceptamos una escena que el owner nunca
            // aprobó (eso violaba el consentimiento). Cortamos el run con un mensaje
            // claro; el owner retoma con "Forkear" desde la última escena aprobada.
            throw new Error(
              `Timeout esperando tu aprobación en la escena ${animated.index}. El run se detuvo para no entregar una escena sin tu visto bueno — usa "Forkear" desde la última escena aprobada para continuar cuando quieras.`,
            );
          }

          // v3.2 #131: PROPAGACIÓN DE CORRECCIONES.
          // Si la aprobación venía con feedback substantivo (comment del owner
          // o newImagePrompt), reescribimos los imagePrompts de las scenes
          // futuras (no procesadas todavía) para que adopten la corrección.
          // Esto evita que el owner tenga que dar el mismo feedback en cada
          // scene si la corrección es identidad-del-personaje o estilo global.
          const ownerFeedbackForPropagation = (() => {
            const parts: string[] = [];
            if (approval.intervention?.comment) parts.push(approval.intervention.comment);
            if (approval.newImagePrompt && approval.action === 'reject')
              parts.push(`[Prompt corregido aplicado en esta scene: ${approval.newImagePrompt.slice(0, 1500)}]`);
            for (const c of approval.additionalComments) parts.push(c);
            return parts.join('\n\n');
          })();
          if (
            ownerFeedbackForPropagation.length > 0 &&
            (approval.action === 'approve' || approval.action === 'reject')
          ) {
            try {
              // v3.2 #138 audit fix: results es array indexado por originalIdx
              // (orden de inserción al queue), NO por scene.index. Usar
              // scene.videoPath directamente para detectar pre-animadas.
              // Tampoco propagar a scenes pre-aprobadas (fork) — sus prompts
              // los lockeó el owner en el run de origen.
              const futureCandidates = opts.sceneTrack.scenes.filter(
                (s) =>
                  s.index > animated.index &&
                  !s.videoPath &&
                  !opts.preApprovedSceneIndices?.has(s.index),
              );
              if (futureCandidates.length > 0) {
                const { propagateCorrections } = await import('./propagate-corrections');
                const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
                if (apiKey && !apiKey.startsWith('ROTATE_')) {
                  opts.logger?.info(
                    {
                      fromSceneIndex: animated.index,
                      candidatesCount: futureCandidates.length,
                      entity: 'PROPAGATE CORRECTIONS',
                    },
                    'scene-animator:propagation_started',
                  );
                  const prop = await propagateCorrections({
                    apiKey,
                    fromSceneIndex: animated.index,
                    ownerComment: ownerFeedbackForPropagation,
                    scenesToEvaluate: futureCandidates.map((s) => ({
                      index: s.index,
                      imagePrompt: s.imagePrompt,
                      text: s.text,
                    })),
                    brandContext: opts.validator.brandContext
                      ? {
                          brandId: opts.validator.brandContext.brandId,
                          productName: opts.validator.brandContext.productName,
                          styleSummary: opts.validator.brandContext.styleSummary,
                          language: opts.validator.brandContext.language,
                        }
                      : undefined,
                    logger: opts.logger,
                  });
                  if (prop && prop.updatedScenes.length > 0) {
                    let mutatedCount = 0;
                    for (const u of prop.updatedScenes) {
                      if (u.unchanged) continue;
                      // MUTACIÓN IN-PLACE de la scene en sceneTrack. Como la
                      // queue del worker tiene referencias al MISMO objeto,
                      // la próxima iteración va a ver el imagePrompt nuevo.
                      const target = opts.sceneTrack.scenes.find(
                        (s) => s.index === u.sceneIndex,
                      );
                      if (target) {
                        target.imagePrompt = u.newPrompt;
                        mutatedCount++;
                      }
                    }
                    // Persistir scene-plan.json para que la UI muestre los
                    // prompts actualizados al refrescar.
                    try {
                      const planPath = resolve(opts.workDir, 'scene-plan.json');
                      await writeFile(planPath, JSON.stringify(opts.sceneTrack, null, 2), 'utf-8');
                    } catch (writeErr) {
                      opts.logger?.warn(
                        { err: (writeErr as Error).message, entity: 'PROPAGATE CORRECTIONS' },
                        'scene-animator:propagation_persist_failed',
                      );
                    }
                    opts.logger?.info(
                      {
                        fromSceneIndex: animated.index,
                        mutatedCount,
                        candidatesCount: futureCandidates.length,
                        rationale: prop.rationale.slice(0, 200),
                        entity: 'PROPAGATE CORRECTIONS',
                      },
                      'scene-animator:propagation_applied',
                    );
                  }
                }
              }
            } catch (propErr) {
              opts.logger?.warn(
                {
                  sceneIndex: animated.index,
                  err: (propErr as Error).message,
                  entity: 'PROPAGATE CORRECTIONS',
                },
                'scene-animator:propagation_failed_continuing',
              );
            }
          }
        } catch (e) {
          opts.logger?.warn(
            { sceneIndex: animated.index, err: (e as Error).message, entity: 'COLLABORATIVE MODE' },
            'scene-animator:collaborative_pause_threw_continuing',
          );
        }
      }

      results[item.originalIdx] = animated;
      done += 1;
      opts.onProgress?.(done, total, item.scene.index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  return {
    ...opts.sceneTrack,
    scenes: results,
  };
}
