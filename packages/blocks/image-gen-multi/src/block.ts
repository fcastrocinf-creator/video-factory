import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Bottleneck from 'bottleneck';
import { err, ok, type Result } from 'neverthrow';
import {
  BlockError,
  recordError,
  type Block,
  type BlockContext,
  type ErrorCategory,
} from '@video-factory/core';
import {
  SceneTrackSchema,
  type Scene,
  type SceneTrack,
} from '@video-factory/contracts';
import {
  GeminiImageProvider,
  GoogleImagenProvider,
  ImageProviderError,
  type ImageProvider,
} from '@video-factory/block-image-gen-imagen';
import { ImagenClient } from '@video-factory/block-image-gen-imagen';
import {
  SceneSequenceValidator,
  SceneValidatorV3,
  type V3ValidationResult,
} from '@video-factory/block-scene-validator';
import {
  judgeImage,
  type JudgeReport,
  type JudgeOptions,
} from '@video-factory/block-preview-judge';

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) throw new Error('PNG demasiado corto');
  const sigA = buffer.readUInt32BE(0);
  const sigB = buffer.readUInt32BE(4);
  if (sigA !== 0x89504e47 || sigB !== 0x0d0a1a0a) throw new Error('No es PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export interface ProviderStep {
  // Provider concreto (GoogleImagenProvider, FalProvider, etc.)
  provider: ImageProvider;
  // Modelo específico dentro de este provider. Si está vacío, el provider usa su default.
  model?: string;
  // Label legible para logs.
  label?: string;
  // OPCIONAL: imagen de referencia para este step (image-to-image). Solo la usan
  // providers que la soportan (Gemini Nano Banana). Cuando está, el prompt se
  // refuerza para "estilo solamente". Los demás steps la dejan undefined.
  referenceImage?: Buffer;
}

export interface ImageGenMultiBlockOptions {
  client?: ImagenClient;
  validator?: SceneValidatorV3;
  concurrency?: number;
  model?: string;
  // Cadena de modelos para fallback automático cuando un modelo agota su quota DIARIA.
  // [LEGACY: usa solo GoogleImagenProvider con distintos modelos]
  modelChain?: string[];
  // Cadena de provider-steps. Permite mezclar proveedores (Google + fal.ai, etc).
  // Si está provista, tiene precedencia sobre modelChain.
  // Cuando un step agota su quota daily, se salta al siguiente.
  providerChain?: ProviderStep[];
  // Modelo alternativo a usar en reintentos por VALIDACIÓN (no por quota).
  // Si una imagen falla validación, regeneramos con este modelo en attempts >= 1.
  retryModel?: string;
  minIntervalMs?: number;
  maxApiRetries?: number;
  // Si true, se llama al validator multimodal después de cada imagen y se
  // re-genera con prompt refinado si el veredicto es "regenerate".
  validate?: boolean;
  // Cuántos reintentos por VALIDACIÓN (no por API errors).
  maxValidationRetries?: number;
  // Score mínimo (0-100) que el validator debe asignar para aceptar la escena.
  // Default 75 — fuerza re-generación incluso cuando verdict='pass' si score < 75.
  minPassScore?: number;
  // Si true, después de generar todas las escenas con éxito, se hace una pasada
  // adicional con scene-sequence-validator (Gemini Vision multimodal con TODAS
  // las imágenes a la vez) para detectar problemas de continuidad cross-scene.
  // Las escenas flagged se re-generan una vez más con el hint de secuencia.
  validateSequence?: boolean;
  // Score mínimo de cohesión global para aceptar la secuencia (0-100).
  minSequenceScore?: number;
  // Información del narrador para pasarle al validator (opcional).
  // CRÍTICO: solo se pasa al validator en escenas que MUESTRAN al narrador.
  // En escenas que muestran a otros personajes (paciente, etc.), se omite para
  // evitar que Gemini Vision confunda "narrador esperado" con "personaje en escena"
  // y rechace escenas válidas como "character mismatch".
  narratorProfile?: {
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: string;
    characterCard?: string;
    narratorPresent?: boolean;
  };
  // Estilo base del preset, para validar consistencia.
  styleBase?: string;
  // ALTA FIDELIDAD (gated por preset): imagen de referencia para anclar el estilo
  // vía Nano Banana (image-to-image). Cuando viene, se antepone un step Nano Banana
  // que genera cada escena anclada a esta imagen. Si es undefined, el chain queda
  // EXACTAMENTE igual que antes (cero impacto en presets sin referencia).
  referenceImage?: Buffer;
  // ANATOMÍA POR RUTA (ver route-profiles.ts). 'strict' (default) = anatomía humana
  // dura (UGC/real). 'lenient' = cartoon/ilustrado (no se rechaza por conteo de
  // dedos/toes/proporciones). Se pasa tal cual al SceneValidatorV3.
  anatomyMode?: 'strict' | 'lenient';
  // FAST MODE — sacrifica algunas validaciones avanzadas para acelerar el render.
  // Cuando true:
  //   - Skip anatomy voting (2 calls Gemini paralelos por escena → ahorro ~7s)
  //   - Skip adversarial critique (1 call Gemini extra por escena → ahorro ~5s)
  //   - Skip sequence validator post-batch (1 call multimodal → ahorro ~30s)
  //   - maxValidationRetries baja automáticamente a 1 (ahorro ~5-10 min en peor caso)
  // Solo deja el cuestionario estructurado principal (catch text gibberish,
  // numbers, semantic mismatch, body proportions — los más comunes).
  // Total ahorro estimado: ~10-15 min en peor caso para 27 escenas.
  // Trade-off: ~10-15% mayor probabilidad de pasar errores anatómicos sutiles.
  fastMode?: boolean;

  // M2 (24-may-2026) — segundo par de ojos con Claude. Cuando true Y hay
  // ANTHROPIC_API_KEY, después de que SceneValidatorV3 dice "pass", invocamos
  // judgeImage() (Haiku 4.5 default) que evalúa scoreVisual / scoreBrandFit /
  // scoreHookStrength + issues categorizados + suggestions accionables.
  // Si Claude rechaza, tratamos como V3 regenerate-style usando suggestions
  // como refinementHint (consume 1 attempt del MAX_VALIDATION_RETRIES).
  // Costo: ~$0.001-0.003 por imagen con Haiku 4.5. Latencia: +2-4s por imagen.
  useClaudeJudge?: boolean;
  claudeJudgeOptions?: JudgeOptions;
  // Contexto de brand que se pasa al judge para evaluar scoreBrandFit con info real.
  // No se usa para V3 (V3 trabaja a nivel anatomía/semántica).
  brandContext?: {
    brandId?: string;
    palette?: string[];
    styleSummary?: string;
    productName?: string;
    productDescription?: string;
    productUsageForm?: string;
    language?: string;
  };
  // v2 (27-may-2026): callback que se dispara cada vez que el judge sugiere un
  // patch sistémico (`suggestedSystemicPatch` en algún issue). El caller
  // (pipeline.ts) trackea cross-scene del mismo run — si el mismo patch aparece
  // en 2+ scenes → registra como propuesta en prompt-patches para review.
  // Esto IMPLEMENTA el flujo que pidió el owner:
  //   scene → judge → si problema sistémico → propone corrección permanente al preset
  onSystemicPatchSuggested?: (info: {
    patch: string;
    sceneIndex: number;
    severity: 'minor' | 'major' | 'critical';
    category: string;
    description: string;
  }) => void;
  // Script completo (resumen) para inyectar como context al judge — permite
  // detectar inconsistencias narrativas más profundas.
  scriptFullSummary?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Detecta si el imagePrompt de una escena describe al NARRADOR (que va a ser
 * dibujado en la imagen) o a un personaje DISTINTO (ej. paciente, otro adulto,
 * un niño, etc.).
 *
 * Crítico para que el validator NO confunda "imagen muestra a la paciente" con
 * "imagen no muestra al narrador". Si la escena no es del narrador, el validator
 * recibe narratorProfile=undefined y juzga puramente prompt↔imagen.
 */
function doesSceneShowNarrator(
  imagePrompt: string,
  narratorProfile?: { characterCard?: string; gender?: string; narratorPresent?: boolean },
): boolean {
  if (!narratorProfile?.narratorPresent || !narratorProfile.characterCard) return false;
  const prompt = imagePrompt.toLowerCase();
  const card = narratorProfile.characterCard.toLowerCase();

  // Extraemos keywords distintivos del character card (etnia, profesión, rasgos físicos)
  const cardKeywords = (card.match(
    /\b(japanese|asian|latino|european|african|chinese|korean|indian|monk|doctor|specialist|expert|elder|wise|señor|señora|priest|nun|teacher|engineer|scientist|chef|musician)\b/g,
  ) ?? []) as string[];

  // Si el prompt menciona ANY keyword distintivo del card, probablemente muestra al narrador
  const hasNarratorKeywords = cardKeywords.some((kw) => prompt.includes(kw));

  // Heurística adicional: si el prompt menciona explícitamente "patient", "young woman",
  // "child", "other person", está pidiendo otro personaje (NO el narrador)
  const explicitlyOtherCharacter =
    /\b(patient|young woman|young man|mujer joven|woman who|man who|other person|otro hombre|otra mujer)\b/i.test(
      prompt,
    );

  if (explicitlyOtherCharacter && !hasNarratorKeywords) return false;
  return hasNarratorKeywords;
}

function parseRetryDelaySeconds(body: string): number | null {
  const m = body.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/);
  if (!m) return null;
  return parseFloat(m[1]!);
}

// ============================================================================
// Throttling per-provider via Bottleneck
// ============================================================================
// Cada provider del chain tiene su propio rate limit real; usar UN throttle
// GLOBAL (como el `acquireSlot + MIN_INTERVAL_MS` anterior) no respeta esa
// diversidad — algunos providers reciben demasiados requests y otros muy pocos.
//
// TUNING POST 24-MAY-2026 — BUDGET $5-7/VIDEO (paid tier):
// Subimos los límites después de validar que el modo fast era demasiado lento
// (~20+ min vs 5-7 min del benchmark del owner) por throttling conservador.
// El owner confirmó budget paid, así que destrabamos:
//   - Gemini Nano Banana (Tier 1 paid): subimos reservoir 10→30 IPM, concurrency 4→8.
//   - Vertex Imagen us-central1: minTime 1200→600ms, concurrency 2→4 (proyecto billed).
//   - OpenAI gpt-image-1: concurrency 5→10, minTime 200→100ms (Tier 2+ permitido).
//   - AI Studio Imagen tier 1: SIN CAMBIO — daily caps son hard, no sirve subir.
//   - Higgsfield / fal: subimos para aprovechar paid tier.
//
// Los limiters viven a NIVEL MÓDULO (no por instancia del block) para que dos
// rips concurrentes compartan el mismo throttle por provider — si fueran
// per-instancia, cada rip dispararía su quota independientemente y reventaríamos
// todos los caps.
//
// Si reverse: bajamos a los valores anteriores (commit anterior) — el sistema
// funcionaba pero conservador para tier gratuito.
//
// Ver investigacion/99-PLAN-FINAL.md paso 3 + investigacion/04-resilience-patterns-ts.md.

const limiters = new Map<string, Bottleneck>();

function makeLimiterFor(providerName: string): Bottleneck {
  switch (providerName) {
    case 'gemini-image':
      // Nano Banana paid tier: 30 IPM (3x el conservador previo). Reservoir
      // refills cada 60s. maxConcurrent 8 = doble el anterior.
      return new Bottleneck({
        reservoir: 30,
        reservoirRefreshAmount: 30,
        reservoirRefreshInterval: 60_000,
        maxConcurrent: 8,
        minTime: 100,
      });
    case 'vertex-imagen':
      // Vertex Imagen `us-central1` paid: target ~100 RPM. minTime 600ms,
      // concurrency 4 (doble el anterior). Si pega quota Bug 1 + Bug 2 saltan.
      return new Bottleneck({ minTime: 600, maxConcurrent: 4 });
    case 'openai-image':
      // OpenAI gpt-image-1: ya tiene retry interno con backoff explícito por 429.
      // En Tier 2+ subimos concurrencia 10 y minTime 100ms (vs 5 / 200 anterior).
      return new Bottleneck({ maxConcurrent: 10, minTime: 100 });
    case 'google-imagen':
      // AI Studio Imagen tier 1: daily caps + RPM bajo. SIN CAMBIO — subir no
      // sirve, el cap es del lado del proveedor (gratuito).
      return new Bottleneck({ maxConcurrent: 1, minTime: 6000 });
    case 'higgsfield-image':
      // Higgsfield paid tier permite más concurrencia que conservador.
      return new Bottleneck({ maxConcurrent: 8, minTime: 150 });
    case 'fal-image':
      // fal.ai paga por uso, sin RPM limit estricto. Subimos concurrency.
      return new Bottleneck({ maxConcurrent: 12, minTime: 100 });
    default:
      // Provider desconocido: pacing conservador (no causar daño).
      return new Bottleneck({ maxConcurrent: 2, minTime: 1000 });
  }
}

function getLimiter(providerName: string): Bottleneck {
  let limiter = limiters.get(providerName);
  if (!limiter) {
    limiter = makeLimiterFor(providerName);
    limiters.set(providerName, limiter);
  }
  return limiter;
}

export class ImageGenMultiBlock implements Block<SceneTrack, SceneTrack> {
  readonly name = 'image-gen-multi';
  readonly version = '2.0.0';
  readonly description =
    'Genera + valida (Gemini Vision) + re-genera imagen por escena. Asegura coherencia semántica, anatomía correcta (manos con 5 dedos), y consistencia de personaje.';

  constructor(private readonly options: ImageGenMultiBlockOptions = {}) {}

  validateInput(input: unknown): Result<SceneTrack, Error> {
    const parsed = SceneTrackSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`SceneTrack inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: SceneTrack, ctx: BlockContext): Promise<Result<SceneTrack, BlockError>> {
    // Construir la cadena de provider-steps.
    // Precedencia: options.providerChain > options.modelChain > options.client > default.
    const apiKey = process.env['GOOGLE_AI_API_KEY'];
    const baseProviderSteps: ProviderStep[] = (() => {
      if (this.options.providerChain && this.options.providerChain.length > 0) {
        return this.options.providerChain;
      }
      if (!apiKey && !this.options.client) {
        return [];
      }
      // Si tenemos client legacy o env GOOGLE_AI_API_KEY, construimos GoogleImagenProvider.
      const googleProvider = new GoogleImagenProvider({ apiKey: apiKey! });
      const models = this.options.modelChain ?? (this.options.model ? [this.options.model] : [
        'imagen-4.0-fast-generate-001',
        'imagen-4.0-generate-001',
        'imagen-4.0-ultra-generate-001',
      ]);
      return models.map((m) => ({ provider: googleProvider, model: m, label: `google:${m}` }));
    })();

    // ALTA FIDELIDAD (gated por preset): si llega una imagen de referencia,
    // anteponemos un step Nano Banana que ANCLA el estilo a esa imagen
    // (image-to-image). El resto del chain queda de fallback. SIN referencia,
    // el chain queda EXACTAMENTE igual que antes (cero impacto en otros presets).
    const referenceImageForGen = this.options.referenceImage;
    const googleKeyForRef = process.env['GOOGLE_AI_API_KEY'];
    const providerSteps: ProviderStep[] =
      referenceImageForGen && googleKeyForRef
        ? [
            {
              provider: new GeminiImageProvider({ apiKey: googleKeyForRef, name: 'gemini-image' }),
              model: 'gemini-2.5-flash-image',
              label: 'gemini:nano-banana-ref',
              referenceImage: referenceImageForGen,
            },
            ...baseProviderSteps,
          ]
        : baseProviderSteps;

    if (providerSteps.length === 0) {
      return err(
        new BlockError(this.name, 'MISSING_API_KEY', 'No hay providers configurados. Setea GOOGLE_AI_API_KEY o pasa providerChain.', false),
      );
    }

    const validator = this.options.validate
      ? this.options.validator ?? new SceneValidatorV3()
      : null;
    if (this.options.validate && validator && !validator.isAvailable()) {
      ctx.logger.warn(
        { runId: ctx.runId, block: this.name },
        'image-gen-multi:validator_unavailable — corriendo sin validación',
      );
    }

    await mkdir(ctx.workDir, { recursive: true });

    const CONCURRENCY = this.options.concurrency ?? 2;
    const MAX_API_RETRIES = this.options.maxApiRetries ?? 5;
    // Nota: `options.minIntervalMs` queda DEPRECATED — el throttling ahora es
    // per-provider via Bottleneck (ver helpers `getLimiter` arriba). Si llega
    // configurado, lo ignoramos silenciosamente para mantener backward compat.
    void this.options.minIntervalMs;
    // En fastMode reducimos retries de validación de 3 a 1 (ahorra ~10 min peor caso)
    const fastMode = this.options.fastMode ?? false;
    const MAX_VALIDATION_RETRIES = this.options.maxValidationRetries ?? (fastMode ? 1 : 3);
    // Score mínimo para aceptar una escena como "pass". El validator devuelve
    // verdict='pass' pero todavía requerimos score >= MIN_PASS_SCORE para evitar
    // imágenes con defectos notables que pasaron por "ok pero borderline".
    const MIN_PASS_SCORE = this.options.minPassScore ?? 75;
    const PRIMARY_MODEL = this.options.model;
    const RETRY_MODEL = this.options.retryModel;

    // Set compartido entre workers de provider-steps agotados por hoy.
    const exhaustedSteps = new Set<number>(); // indices into providerSteps
    const pickNextAvailableStep = (): ProviderStep | null => {
      for (let i = 0; i < providerSteps.length; i++) {
        if (!exhaustedSteps.has(i)) return providerSteps[i] ?? null;
      }
      return null;
    };
    const indexOfStep = (step: ProviderStep): number => providerSteps.indexOf(step);
    void PRIMARY_MODEL; // referenced in deps; preserved for legacy log compat
    void RETRY_MODEL;

    let completed = 0;
    const scenes: Scene[] = new Array(input.scenes.length);

    // Throttling per-provider lo maneja ahora `getLimiter()` (Bottleneck) — ver
    // helpers al inicio del archivo. Reemplaza el throttle GLOBAL anterior basado
    // en `nextSlotAt + acquireSlot()` (un único MIN_INTERVAL_MS para todos los
    // providers, que no respeta caps individuales). Paso 3 del 99-PLAN-FINAL.md.

    // Llama a un provider con dos niveles de resiliencia:
    //   1. Retry-with-backoff para errores transitorios (429 per-minute, 5xx)
    //   2. Provider fallback automático cuando un step agota su quota DIARIA:
    //      el step se marca como exhausted y el call se rehace con el siguiente
    //      step de la chain (que puede ser otro modelo del mismo provider, o
    //      otro provider entero como fal.ai).
    const callProviderWithApiRetry = async (
      prompt: string,
      sceneIdx: number,
      attempt: number,
    ): Promise<Buffer> => {
      let lastErr: unknown = null;
      while (true) {
        const step = pickNextAvailableStep();
        if (!step) {
          throw (
            lastErr ??
            new ImageProviderError(
              `All providers in chain exhausted for the day. Wait for quota reset or add another provider (fal.ai, etc).`,
              429,
              '',
              false,
              true,
              'chain',
            )
          );
        }
        const stepIdx = indexOfStep(step);
        const stepLabel = step.label ?? `${step.provider.name}:${step.model ?? 'default'}`;

        let stepExhausted = false;
        for (let i = 0; i <= MAX_API_RETRIES; i++) {
          try {
            // Bottleneck per-provider — throttling según los rate limits reales
            // de cada provider, no un global único. (Paso 3 del 99-PLAN-FINAL.md.)
            const buffer = await getLimiter(step.provider.name).schedule(() =>
              step.provider.generate({
                // Si este step ancla a una imagen de referencia (Nano Banana),
                // reforzamos: usar la referencia SOLO para estilo, renderizando el
                // contenido de ESTA escena, sin copiar objetos/UI/texto del original.
                prompt: step.referenceImage
                  ? `${prompt}\n\nIMPORTANT: use the provided reference image ONLY to match its visual STYLE — color palette, lighting, art medium and character-rendering style. Render THIS scene's described content in that same style. Do NOT copy the reference's specific objects, composition, or any text/UI/logos from it.`
                  : prompt,
                aspectRatio: '9:16',
                model: step.model,
                referenceImage: step.referenceImage,
              }),
            );
            readPngDimensions(buffer);
            return buffer;
          } catch (e) {
            lastErr = e;
            const isProvErr = e instanceof ImageProviderError;
            if (isProvErr && e.isDailyQuotaExhausted) {
              exhaustedSteps.add(stepIdx);
              ctx.logger.warn(
                {
                  runId: ctx.runId,
                  scene: sceneIdx,
                  exhaustedStep: stepLabel,
                  remaining: providerSteps
                    .filter((_, idx) => !exhaustedSteps.has(idx))
                    .map((s) => s.label ?? `${s.provider.name}:${s.model ?? 'default'}`),
                },
                'image-gen-multi:provider_daily_quota_exhausted_switching',
              );
              stepExhausted = true;
              break;
            }
            // Content rejection (NSFW, safety filter): probamos siguiente provider.
            // Si no hay más providers disponibles, dejamos que el error propague al
            // outer validation loop para retry con prompt suavizado.
            if (isProvErr && e.isContentRejection) {
              const otherAvailable = providerSteps.some(
                (_, idx) => idx !== stepIdx && !exhaustedSteps.has(idx),
              );
              if (otherAvailable) {
                ctx.logger.warn(
                  {
                    runId: ctx.runId,
                    scene: sceneIdx,
                    rejectedStep: stepLabel,
                    reason: e.message.slice(0, 200),
                  },
                  'image-gen-multi:content_rejection_trying_next_provider',
                );
                // Mark globally exhausted: si UN scene es NSFW para este model,
                // probablemente OTROS scenes con prompts similares también lo van a ser.
                exhaustedSteps.add(stepIdx);
                stepExhausted = true;
                break;
              }
              // Sin otros providers: propaga el error al outer validation loop
              // para que retry con prompt sanitizado.
              ctx.logger.warn(
                { runId: ctx.runId, scene: sceneIdx, rejectedStep: stepLabel },
                'image-gen-multi:content_rejection_no_fallback_provider',
              );
              throw e;
            }
            const retryable = isProvErr ? e.retryable : true;
            // Bug 2 fix (investigacion/01-image-gen-multi-block-analysis.md):
            // si AGOTAMOS retries en un step retryable, NO hacemos throw —
            // marcamos el step como exhausted y dejamos que el while exterior
            // salte al próximo provider. Sin esto, un provider que se queda
            // colgado en 429 transient tumba el rip entero después de N retries
            // sin tocar Higgsfield / fal / AI Studio.
            if (i === MAX_API_RETRIES) {
              ctx.logger.warn(
                {
                  runId: ctx.runId,
                  scene: sceneIdx,
                  step: stepLabel,
                  maxRetries: MAX_API_RETRIES,
                  lastStatus: isProvErr ? e.statusCode : undefined,
                },
                'image-gen-multi:step_retries_exhausted_marking_dead',
              );
              exhaustedSteps.add(stepIdx);
              stepExhausted = true;
              break;
            }
            if (!retryable) throw e;
            const explicit = isProvErr ? parseRetryDelaySeconds(e.responseBody) : null;
            const backoffSec = explicit ?? Math.min(60, 4 * 2 ** i);
            ctx.logger.warn(
              {
                runId: ctx.runId,
                scene: sceneIdx,
                validationAttempt: attempt,
                step: stepLabel,
                apiAttempt: i,
                backoffSec,
                statusCode: isProvErr ? e.statusCode : undefined,
              },
              'image-gen-multi:api_retrying',
            );
            // El throttling per-provider (Bottleneck) maneja el pacing entre
            // requests automáticamente; solo necesitamos el sleep para el backoff
            // de retry. Ya no hace falta actualizar nextSlotAt (no existe).
            await sleep(backoffSec * 1000);
          }
        }
        if (!stepExhausted) {
          throw lastErr ?? new Error('Image multi: API retries agotados sin daily-quota signal');
        }
      }
    };

    // Backwards-compatible alias usado por el resto del código.
    const callImagenWithApiRetry = (
      prompt: string,
      sceneIdx: number,
      attempt: number,
      _preferredModel: string | undefined,
    ) => callProviderWithApiRetry(prompt, sceneIdx, attempt);

    // Genera UNA escena con validación + re-generación si falla.
    // v3.3 (29-may #fix-fork): los archivos se nombran por `scene.index` (NO por la
    // posición `index` del array). En runs normales coinciden, pero en un FORK el
    // track viene filtrado (solo las scenes nuevas) → usar la posición escribiría
    // scene_00.png y CLOBBEARÍA la scene 0 aprobada. `index` queda solo para el
    // placement en `scenes[]` (que el pipeline fusiona por .index al volver del fork).
    const generateAndValidate = async (scene: Scene, index: number): Promise<void> => {
      let currentPrompt = scene.imagePrompt;
      let lastValidation: V3ValidationResult | null = null;
      const refinementLog: string[] = [];

      for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
        // En reintentos por validación, alternamos modelo: primero el primario (Fast,
        // económico), si falla validación usamos el modelo retry (std, mejor anatomía).
        const modelToUse = attempt === 0 ? PRIMARY_MODEL : RETRY_MODEL ?? PRIMARY_MODEL;
        let buffer: Buffer;
        try {
          buffer = await callImagenWithApiRetry(currentPrompt, index, attempt, modelToUse);
        } catch (e) {
          // Manejo especial de NSFW/content-rejection cuando NO hay más providers:
          // suavizamos el prompt automáticamente y reintentamos en el siguiente
          // attempt del outer loop. Si attempt es el último, scene_done_with_issues.
          if (e instanceof ImageProviderError && e.isContentRejection) {
            if (attempt < MAX_VALIDATION_RETRIES) {
              const sanitizationHint =
                'IMPORTANT SAFETY CONSTRAINT: Avoid any depiction that could be flagged as NSFW, sexual, violent, distressing, or showing wounds/blood. Use neutral, abstract or symbolic representations. Avoid showing exposed skin, intense facial pain expressions, or anatomically detailed body interiors.';
              currentPrompt = `${scene.imagePrompt}\n\n${sanitizationHint}`;
              refinementLog.push(sanitizationHint);
              ctx.logger.warn(
                { runId: ctx.runId, scene: index, attempt, nextAttempt: attempt + 1 },
                'image-gen-multi:nsfw_retry_with_sanitized_prompt',
              );
              continue;
            }
            // ÚLTIMO RESORT: el provider sigue rechazando incluso con prompt sanitizado.
            // Generamos una imagen ABSTRACT del estilo (sin elementos problemáticos) como
            // placeholder. Mantiene paleta visual del video y no rompe el render.
            // El log queda como scene_done_with_issues para review humano posterior.
            const safePrompt =
              `${this.options.styleBase ?? 'Soft abstract watercolor'}. Pure atmospheric color wash with soft warm amber and sepia tones. No people, no body parts, no objects — just gentle painterly brush strokes and atmospheric lighting. Vertical 9:16 composition. Completely safe-for-work abstract background art.`;
            ctx.logger.warn(
              { runId: ctx.runId, scene: index, attempt, finalAttempt: 'safe_placeholder' },
              'image-gen-multi:nsfw_fallback_safe_placeholder',
            );
            try {
              buffer = await callImagenWithApiRetry(safePrompt, index, attempt, modelToUse);
            } catch (e2) {
              // Si el placeholder ABSTRACT también falla → fail definitivo (algo está roto)
              ctx.logger.error(
                { runId: ctx.runId, scene: index, err: (e2 as Error).message },
                'image-gen-multi:safe_placeholder_also_failed',
              );
              throw e2;
            }
            // Aceptamos el placeholder con warning + record en Error Memory
            const imagePath = join(ctx.workDir, `scene_${scene.index.toString().padStart(2, '0')}.png`);
            await writeFile(imagePath, buffer);
            completed++;
            scenes[index] = { ...scene, imagePath };
            ctx.onBlockProgress?.(Math.round((completed / input.scenes.length) * 100));
            ctx.logger.warn(
              { runId: ctx.runId, scene: index, attempt, fallback: 'abstract_placeholder', refinementsApplied: refinementLog },
              'image-gen-multi:scene_done_with_issues',
            );
            return;
          }
          throw e;
        }

        // Si no hay validator activo, aceptamos la primera imagen.
        if (!validator || !validator.isAvailable()) {
          const imagePath = join(ctx.workDir, `scene_${scene.index.toString().padStart(2, '0')}.png`);
          await writeFile(imagePath, buffer);
          completed++;
          scenes[index] = { ...scene, imagePath };
          ctx.onBlockProgress?.(Math.round((completed / input.scenes.length) * 100));
          ctx.logger.info(
            { runId: ctx.runId, scene: index, attempt, bytes: buffer.length, completed, total: input.scenes.length, validated: false },
            'image-gen-multi:scene_done',
          );
          return;
        }

        // CRÍTICO: solo pasamos narratorProfile al validator si la escena
        // realmente muestra al narrador. Si la escena describe a otro personaje
        // (paciente, anciano, etc.), pasar el narratorProfile confunde a Gemini
        // y produce falsos positivos de "character mismatch".
        const sceneShowsNarrator = doesSceneShowNarrator(currentPrompt, this.options.narratorProfile);
        const narratorForValidator = sceneShowsNarrator ? this.options.narratorProfile : undefined;
        // Validamos la imagen con Gemini Vision.
        const validation = await validator.validate({
          text: scene.text,
          imagePrompt: currentPrompt,
          imageBuffer: buffer,
          styleBase: this.options.styleBase,
          narratorProfile: narratorForValidator,
          fastMode,
          anatomyMode: this.options.anatomyMode,
        });
        lastValidation = validation;

        ctx.logger.info(
          {
            runId: ctx.runId,
            scene: index,
            attempt,
            verdict: validation.verdict,
            score: validation.score,
            issues: validation.issues,
            refinementHint: validation.refinementHint,
          },
          'image-gen-multi:scene_validated',
        );

        // Aceptamos sólo si verdict=pass Y score >= MIN_PASS_SCORE. Si pasa pero
        // con score bajo, lo tratamos como regenerate para forzar más iteraciones.
        let v3PassesGate = validation.verdict === 'pass' && validation.score >= MIN_PASS_SCORE;
        let claudeReport: JudgeReport | null = null;

        // M2 — Segundo par de ojos con Claude (si está habilitado y V3 ya pasó).
        // Solo invocamos Claude cuando V3 ya dio luz verde — gastar tokens de Claude
        // en una imagen que V3 ya rechazó sería redundante.
        if (
          v3PassesGate &&
          this.options.useClaudeJudge &&
          process.env['ANTHROPIC_API_KEY'] &&
          !process.env['ANTHROPIC_API_KEY']!.startsWith('ROTATE_')
        ) {
          // v2: contexto cross-scene para detectar continuity issues
          const prevScenesContext = input.scenes
            .slice(Math.max(0, index - 2), index)
            .map((s: Scene) => ({
              index: s.index,
              visualDescription: (s.imagePrompt ?? '').slice(0, 200),
              narration: (s.text ?? '').slice(0, 100),
            }));
          const judgeResult = await judgeImage(
            {
              imageBuffer: buffer,
              imageMimeType: 'image/png',
              prompt: currentPrompt,
              sceneNarration: scene.text,
              brandContext: this.options.brandContext,
              expectedStyle: this.options.styleBase,
              scenePosition: {
                index: scene.index, // v3.3 fix: scene.index real (no la posición del loop filtrado)
                total: input.scenes.length,
                // narrativeBeat + shotType vienen del scene-planner si los seteó
                shotType: (scene as { shotType?: string }).shotType,
              },
              prevScenesContext: prevScenesContext.length > 0 ? prevScenesContext : undefined,
              scriptFullSummary: this.options.scriptFullSummary,
            },
            this.options.claudeJudgeOptions ?? {},
          );
          if (judgeResult.isErr()) {
            // Claude falló (API down, parse error, etc.) — no bloqueamos el pipeline,
            // solo logueamos y aceptamos lo que V3 dijo. Mejor pass tibio que fail
            // por dependencia externa caída.
            ctx.logger.warn(
              {
                runId: ctx.runId,
                scene: index,
                attempt,
                judgeError: judgeResult.error,
              },
              'image-gen-multi:claude_judge_error_continuing_with_v3',
            );
          } else {
            claudeReport = judgeResult.value;
            ctx.logger.info(
              {
                runId: ctx.runId,
                scene: index,
                attempt,
                judgePass: claudeReport.pass,
                scoreVisual: claudeReport.scoreVisual,
                scoreBrandFit: claudeReport.scoreBrandFit,
                scoreHookStrength: claudeReport.scoreHookStrength,
                scoreLogicalCoherence: claudeReport.scoreLogicalCoherence,
                scoreViveness: claudeReport.scoreViveness,
                issuesCount: claudeReport.issues.length,
                rationale: claudeReport.rationale,
              },
              'image-gen-multi:claude_judge_verdict',
            );
            // v2 (27-may-2026): si el judge sugirió un patch sistémico en algún
            // issue, lo emitimos via callback. El caller (pipeline.ts) trackea
            // cross-scene y registra como propuesta en prompt-patches si N+ scenes
            // reportan el mismo patch.
            if (this.options.onSystemicPatchSuggested) {
              for (const issue of claudeReport.issues) {
                const i = issue as typeof issue & { suggestedSystemicPatch?: string };
                if (i.suggestedSystemicPatch && i.suggestedSystemicPatch.trim().length > 10) {
                  try {
                    this.options.onSystemicPatchSuggested({
                      patch: i.suggestedSystemicPatch.trim(),
                      sceneIndex: index,
                      severity: issue.severity,
                      category: issue.category,
                      description: issue.description,
                    });
                  } catch {
                    // best-effort — callback no debe romper el pipeline
                  }
                }
              }
            }
            if (!claudeReport.pass) {
              // Claude rechazó — tratamos como V3 regenerate-style.
              // Las suggestions se convierten en refinementHint para el próximo attempt.
              v3PassesGate = false;
              const claudeIssuesAsText = claudeReport.issues
                .map(
                  (i: { severity: string; category: string; description: string }) =>
                    `[${i.severity}/${i.category}] ${i.description}`,
                )
                .join(' | ');
              const claudeHint =
                claudeReport.suggestions.length > 0
                  ? claudeReport.suggestions.join('. ')
                  : `Improve quality. ${claudeReport.rationale}`;
              // Override lastValidation con el feedback de Claude para que el
              // bloque downstream (refinement) use el hint del judge. Poblamos
              // los campos required de V3ValidationResult con valores derivados
              // del judge — más limpio que cast forzado, y mantiene compatibilidad
              // con recordSceneError() que lee issues[] / refinementHint / score.
              lastValidation = {
                verdict: 'regenerate' as const,
                score: claudeReport.scoreVisual,
                issues: [`claude-judge: ${claudeIssuesAsText}`],
                refinementHint: claudeHint,
                reasoning: `Claude judge rejected: ${claudeReport.rationale}`,
                structuredAnswers: null,
              };
            }
          }
        }

        if (v3PassesGate) {
          const imagePath = join(ctx.workDir, `scene_${scene.index.toString().padStart(2, '0')}.png`);
          await writeFile(imagePath, buffer);
          completed++;
          scenes[index] = { ...scene, imagePath };
          ctx.onBlockProgress?.(Math.round((completed / input.scenes.length) * 100));
          ctx.logger.info(
            {
              runId: ctx.runId,
              scene: index,
              attempt,
              bytes: buffer.length,
              score: validation.score,
              claudeScore: claudeReport?.scoreVisual,
              completed,
              total: input.scenes.length,
              refinementsApplied: refinementLog.length,
            },
            'image-gen-multi:scene_done',
          );
          return;
        }

        // Si es fatal o se acabaron los reintentos → guardamos lo que hay y warning.
        if (validation.verdict === 'fatal' || attempt === MAX_VALIDATION_RETRIES) {
          const imagePath = join(ctx.workDir, `scene_${scene.index.toString().padStart(2, '0')}.png`);
          await writeFile(imagePath, buffer);
          completed++;
          scenes[index] = { ...scene, imagePath };
          ctx.onBlockProgress?.(Math.round((completed / input.scenes.length) * 100));
          ctx.logger.warn(
            {
              runId: ctx.runId,
              scene: index,
              attempt,
              finalVerdict: validation.verdict,
              finalScore: validation.score,
              issues: validation.issues,
              refinementsApplied: refinementLog,
            },
            'image-gen-multi:scene_done_with_issues',
          );
          // Registrar en Error Memory para que futuros runs aprendan del fallo.
          await recordSceneError({
            runId: ctx.runId,
            scene,
            providerLabel: pickNextAvailableStep()?.label ?? 'unknown',
            providerModel: pickNextAvailableStep()?.model ?? 'unknown',
            validation,
            attemptedHints: refinementLog,
            brand: ctx.brand?.id,
            preset: ctx.preset?.id,
          }).catch((e) => {
            ctx.logger.warn({ runId: ctx.runId, err: (e as Error).message }, 'image-gen-multi:error_memory_record_failed');
          });
          return;
        }

        // verdict='regenerate' y aún hay reintentos disponibles: refinamos prompt.
        const hint = validation.refinementHint?.trim();
        if (hint && hint.length > 0) {
          refinementLog.push(hint);
          // Estrategia: concatenamos el hint como instrucción imperativa fuerte al final.
          currentPrompt = `${scene.imagePrompt}\n\nCRITICAL CORRECTION (previous attempt failed visual validation): ${hint}`;
        } else {
          // Sin hint útil — solo cambiamos el seed implícitamente al regenerar.
          currentPrompt = `${scene.imagePrompt} (anatomically correct, photorealistic limb proportions, exactly five fingers per hand)`;
        }
        ctx.logger.info(
          { runId: ctx.runId, scene: index, attempt, nextAttempt: attempt + 1, hint, modelNext: RETRY_MODEL ?? PRIMARY_MODEL },
          'image-gen-multi:scene_refining',
        );
      }
      // Defensa — no debería llegarse acá pero por TypeScript.
      throw new Error(`scene ${index}: loop de validación terminó sin escribir resultado (lastVerdict=${lastValidation?.verdict ?? 'null'})`);
    };

    try {
      let cursor = 0;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          const myIdx = cursor++;
          if (myIdx >= input.scenes.length) return;
          await generateAndValidate(input.scenes[myIdx]!, myIdx);
        }
      });
      await Promise.all(workers);

      // ---- SEQUENCE VALIDATION (post-batch review) ----
      // Después de generar TODAS las escenas, alimentamos las imágenes juntas a
      // Gemini Vision multimodal para detectar problemas que solo son visibles
      // en el conjunto (continuidad de personaje, saltos de estilo, etc.).
      // FastMode skip sequence-validator (ahorra ~30s + posibles regen calls)
      if (this.options.validateSequence && !fastMode) {
        const sequenceValidator = new SceneSequenceValidator();
        if (sequenceValidator.isAvailable()) {
          try {
            // Cargamos todas las imágenes para enviarlas a Gemini.
            const sequenceInputs = await Promise.all(
              scenes.map(async (scene) => ({
                index: scene.index,
                text: scene.text,
                imagePrompt: scene.imagePrompt,
                imageBuffer: await readFile(scene.imagePath!),
              })),
            );

            ctx.logger.info(
              { runId: ctx.runId, block: this.name, sequenceSize: sequenceInputs.length },
              'image-gen-multi:sequence_review_start',
            );

            const review = await sequenceValidator.review({
              scenes: sequenceInputs,
              narratorProfile: this.options.narratorProfile,
              styleBase: this.options.styleBase,
            });

            ctx.logger.info(
              {
                runId: ctx.runId,
                block: this.name,
                overallScore: review.overallScore,
                overallReasoning: review.overallReasoning,
                toRegenerate: review.scenesToRegenerate.map((s) => s.sceneIndex),
              },
              'image-gen-multi:sequence_reviewed',
            );

            // Para cada escena flagged por el sequence-validator, regeneramos UNA vez
            // más concatenando el hint de secuencia al prompt original.
            const minSequenceScore = this.options.minSequenceScore ?? 75;
            const shouldFix = review.overallScore < minSequenceScore || review.scenesToRegenerate.length > 0;
            if (shouldFix) {
              for (const flag of review.scenesToRegenerate) {
                // v3.3 fix: resolver por scene.index real, no por posición del array
                // (flag.sceneIndex es un scene.index; indexar por posición clobbea otra escena).
                const sceneToFix = scenes.find((s) => s?.index === flag.sceneIndex);
                if (!sceneToFix) continue;
                const originalPrompt =
                  input.scenes.find((s) => s.index === flag.sceneIndex)?.imagePrompt ??
                  sceneToFix.imagePrompt;
                const refinedPrompt =
                  `${originalPrompt}\n\nSEQUENCE-LEVEL CORRECTION (the scene didn't fit well with the rest of the video): ${flag.refinementHint}`;
                try {
                  const newBuffer = await callImagenWithApiRetry(
                    refinedPrompt,
                    flag.sceneIndex,
                    99, // attempt label for logs
                    PRIMARY_MODEL,
                  );
                  await writeFile(sceneToFix.imagePath!, newBuffer);
                  ctx.logger.info(
                    {
                      runId: ctx.runId,
                      scene: flag.sceneIndex,
                      hint: flag.refinementHint,
                      issue: flag.issue,
                    },
                    'image-gen-multi:sequence_regenerated',
                  );
                } catch (e) {
                  ctx.logger.warn(
                    {
                      runId: ctx.runId,
                      scene: flag.sceneIndex,
                      err: (e as Error).message,
                    },
                    'image-gen-multi:sequence_regen_failed',
                  );
                }
              }
            }
          } catch (e) {
            ctx.logger.warn(
              { runId: ctx.runId, block: this.name, err: (e as Error).message },
              'image-gen-multi:sequence_review_failed',
            );
          }
        } else {
          ctx.logger.warn(
            { runId: ctx.runId, block: this.name },
            'image-gen-multi:sequence_validator_unavailable',
          );
        }
      }
    } catch (error) {
      const isProvErr = error instanceof ImageProviderError;
      const retryable = isProvErr ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const code = isProvErr ? `API_${error.statusCode}` : 'API_CALL_FAILED';
      return err(
        new BlockError(this.name, code, `Error generando imágenes (multi): ${message}`, retryable, error),
      );
    }

    return ok({
      ...input,
      scenes,
    });
  }
}

export const imageGenMulti = new ImageGenMultiBlock();

// ============================================================
// Error Memory recording
// ============================================================

/**
 * Mapea issues humanos del validator V3 a categorías estructuradas para la KB.
 * Cada issue es un texto descriptivo; matcheamos por keywords para deducir
 * la categoría más relevante.
 */
function categorizeIssues(issues: string[]): ErrorCategory[] {
  const text = issues.join(' ').toLowerCase();
  const cats: ErrorCategory[] = [];
  if (/finger|digit|hand_\d|thumb/i.test(text)) cats.push('anatomy_hands');
  if (/toe|foot_\d/i.test(text)) cats.push('anatomy_feet');
  if (/face|eye|nose|mouth|symmetry/i.test(text)) cats.push('anatomy_face');
  if (/proportion|larger than head|too small/i.test(text)) cats.push('body_proportions');
  if (/fusion|fuse|merge/i.test(text)) cats.push('body_part_fusion');
  if (/gibberish|illegible|nonsense|text/i.test(text)) cats.push('text_gibberish');
  if (/number|calendar|sequential/i.test(text)) cats.push('numbers_illogical');
  if (/illogical visual|infinity|abstract|symbol|geometric/i.test(text))
    cats.push('illogical_element');
  if (/semantic|does not match|disconnected|narration/i.test(text)) cats.push('semantic_mismatch');
  if (/character mismatch|gender|ethnic|age/i.test(text)) cats.push('character_mismatch');
  if (/style/i.test(text)) cats.push('style_break');
  if (cats.length === 0) cats.push('other');
  return cats;
}

function extractKeywords(narration: string, errorDescription: string): string[] {
  const text = `${narration} ${errorDescription}`.toLowerCase();
  // Keywords útiles para matching futuro
  const candidates = text.match(
    /\b(ojeras|dark[\s-]?circles?|swollen|hinchada|finger|dedo|toe|hand|mano|foot|pie|face|cara|skin|piel|calendar|days?|d[ií]as?|vitaly|gotas?|number|m[óo]vil|riñ[oó]n|kidney|infinity|abstract|gibberish|label)\b/g,
  );
  return [...new Set(candidates ?? [])].slice(0, 10);
}

async function recordSceneError(opts: {
  runId: string;
  scene: Scene;
  providerLabel: string;
  providerModel: string;
  validation: V3ValidationResult;
  attemptedHints: string[];
  brand?: string;
  preset?: string;
}): Promise<void> {
  const cats = categorizeIssues(opts.validation.issues);
  // Una entrada por categoría detectada (max 3 para evitar inflar KB)
  for (const cat of cats.slice(0, 3)) {
    await recordError({
      runId: opts.runId,
      provider: opts.providerLabel.split(':')[0] ?? opts.providerLabel,
      model: opts.providerModel,
      brand: opts.brand,
      preset: opts.preset,
      narration: opts.scene.text,
      originalPrompt: opts.scene.imagePrompt,
      errorCategory: cat,
      errorDescription: opts.validation.issues.join(' | ').slice(0, 500),
      validatorScore: opts.validation.score,
      refinementHintGiven: opts.validation.refinementHint ?? undefined,
      keywords: extractKeywords(opts.scene.text, opts.validation.issues.join(' ')),
      wasFixed: false, // se marcará true si en futuras runs el mismo hint funciona
    });
  }
}
