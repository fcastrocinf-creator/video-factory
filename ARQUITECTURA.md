# ARQUITECTURA — Video Factory

> ⚠️ **PARCIALMENTE STALE (fechado 2026-05-23).** Partes de este doc quedaron atrás: la **cascada
> multi-provider de imágenes YA está arreglada** (Bug1+Bug2), y NO menciona el **círculo de mejora**,
> la **compuerta de calidad obligatoria** ni el **brazo de auto-reparación** (todo ya construido a
> nivel código, jun-2026). Para el estado REAL verificado del sistema, lee primero
> **`docs/ESTADO-VERIFICADO-2026-06-05.md`**.

> **Documento maestro de la herramienta.** Si retomas trabajo o sos un Claude entrando fresco: léelo entero antes de tocar nada. Te da el modelo mental completo del sistema sin necesidad de contexto adicional.
>
> **Relación con otros docs:**
> - `CLAUDE.md` — reglas mínimas para AI assistants + pointers a este archivo.
> - `HANDOFF.md` — estado de la sesión más reciente (qué está WIP, próximos pasos inmediatos).
> - `DOCUMENTO_MAESTRO.md` — spec original v1 (mayo 2026). **Obsoleto** vs el código actual; se mantiene como referencia histórica.
> - `README.md` — setup técnico breve.
> - `ONBOARDING.md` — guía de instalación para colaboradores.
> - `investigacion/` — carpeta de research; los hallazgos opinados están en `99-PLAN-FINAL.md`.
>
> Última actualización: 2026-05-23.

---

## TL;DR para Claudes con prisa

Video Factory es una herramienta interna para generar **videos verticales 9:16 para ecommerce D2C** (TikTok/Reels, ads, VSL, UGC, etc.). Tiene **tres modos de operación primarios**:

1. **Crear** — usuario escribe un guion + elige brand + preset → herramienta produce MP4.
2. **Ripear** — usuario sube un video de referencia → herramienta lo replica para sus productos con ≥80% similitud visual.
3. **Aprender** — usuario sube un video → herramienta lo analiza, genera prompts hasta lograr ≥92% similitud por keyframe, y destila un **preset reutilizable** que queda en `packages/presets/pending/`.

El motor es un **pipeline de bloques** modulares (script-processor → narrator-analyzer → tts → subtitles → scene-planner → image-gen-multi → scene-animator → compositor-remotion). Cada bloque tiene una interfaz tipada (`Block<I,O>`) y se compone en un `Pipeline`.

**Estado actual:** funciona end-to-end pero tiene un **bug crítico de cascada multi-provider** que tumba rips cuando un proveedor de imagen 429ea. Plan de fix en `investigacion/99-PLAN-FINAL.md`.

**Visión a futuro:** sistema de **perfiles de video** (recipes por categoría/sub-categoría) que routea cada tipo de video a su pipeline óptimo (B-roll animado vs UGC avatar real vs VSL vs composiciones complejas vs etc.). Hoy hay UN pipeline global; el plan es N pipelines según el perfil.

---

## 1. Misión y modos operativos

### 1.1 Misión

Producir, en volumen y de forma confiable, **videos verticales 9:16 listos para ads de ecommerce** para las marcas D2C propias del owner. La herramienta NO es para vender a clientes externos — es de uso interno.

Aplicaciones específicas que se quieren cubrir:
- **Ads de performance** para Meta/TikTok/YouTube Shorts.
- **B-roll animado** (Pixar, acuarela sepia, foto-realista).
- **UGC** (user-generated content style — avatares animados o reales hablando).
- **VSL** (video sales letters, varios sub-tipos por definir).
- **Composiciones complejas** estilo CapCut — collages de N imágenes, mezcla con UGC pantalla verde, edición avanzada.

### 1.2 Los tres modos operativos

#### Modo 1: Crear (`/create`)
**Input:** brand + preset + guion (texto) + product (opcional).
**Salida:** MP4 final.
**Flujo:** pipeline completo desde el guion. Es el modo "construyo el video desde cero".

#### Modo 2: Ripear (`/rip`)
**Input:** brand + producto + preset + **video de referencia** (.mp4) que el usuario quiere "copiar".
**Salida:** MP4 nuevo que replica la estructura y el estilo visual del referencia, adaptado al producto del usuario.
**Pieza clave:** `apps/web/lib/rip-fidelity-aligner.ts`. Threshold de similitud por escena = **80** (FIDELITY_THRESHOLD). Hace detección de composites/grids del original, generación per-panel cuando aplica, anti-hallucination prefixes, auto-escalado a composite real si el generador alucina grids persistentemente.

#### Modo 3: Aprendizaje (`/aprendizaje`)
**Input:** un video de referencia (.mp4) — sin guion, sin brand, sin producto.
**Salida:** un **preset destilado** que queda en `packages/presets/pending/` listo para usar después en Crear/Ripear, + "ideas generales" (resumen ejecutivo extraído por Gemini).
**Pieza clave:** `apps/web/lib/style-trainer.ts`. Threshold = **92** (`SIMILARITY_THRESHOLD`). Itera por keyframe (max **5** iteraciones cada uno) usando comparator Gemini Vision para refinar el prompt hasta converger. Cuando converge construye el preset vía `apps/web/lib/dynamic-preset-builder.ts`.

> **Cómo encajan:** Aprendizaje es el "metalenguaje" — alimenta la biblioteca de presets. Crear y Ripear son los consumidores de esa biblioteca.

### 1.3 Otros modos del UI

- **Videos (`/runs`)** — lista de runs (rips/creates pasados). `/runs/[id]` es el detalle con preview MP4, scenes individuales, validaciones, y opción de re-render.
- **Marcas (`/brands`)** — configuración de marcas (Vitaly, Nelo, etc.): voz default, productos, paleta, tono, ingredients (assets visuales como fotos del producto, logo).
- **Admin (`/admin`)** — aprobación de presets que vienen del Aprendizaje (pasan de `pending/` a la biblioteca activa).
- **Sugerencias** *(NUEVO, ver §10)* — formulario para que el operador deje ideas de mejora; se guardan localmente, NO se aplican automáticamente.

---

## 2. Stack técnico

| Capa | Tecnología | Notas |
|---|---|---|
| Lenguaje | TypeScript 5.9 strict | sin `any` salvo casos justificados |
| Runtime | Node.js 20+ (probado con v24) | |
| Frontend | Next.js 14 (App Router) | UI + API routes en mismo paquete |
| UI | Tailwind + shadcn/ui | |
| DB | SQLite vía libsql + Drizzle ORM | `db/local.db` gitignored |
| Auth | Password único (`APP_PASSWORD` en `.env`) | MVP, un usuario |
| Validación | Zod 3.x | schemas compartidos en `packages/contracts/` |
| Render video | Remotion 4.x | React-based, programatic |
| Monorepo | Turborepo + pnpm workspaces | |
| Logs | Pino | estructurado, con `runId` |
| Errors | neverthrow (`Result<T,E>`) | en los blocks |
| HTTP | undici (built-in Node) | sin axios |

**Comandos clave:**

```bash
pnpm install                         # instala todo el monorepo
pnpm -r typecheck                    # type-check completo (16+ paquetes)
pnpm --filter '@video-factory/web' dev   # levanta UI en localhost:3000
pnpm db:migrate                      # aplica migrations
```

---

## 3. Arquitectura: bloques + pipeline

Toda la lógica pesada vive como **Bloques** independientes en `packages/blocks/{nombre}/`. Cada bloque implementa:

```typescript
// packages/core/src/block.ts
export interface Block<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  validateInput(input: unknown): Result<TInput, Error>;
  run(input: TInput, ctx: BlockContext): Promise<Result<TOutput, BlockError>>;
}

export interface BlockContext {
  runId: string;
  workDir: string;
  logger: Logger;
  brand?: BrandConfig;
  preset?: PresetConfig;
  onBlockProgress?: (pct: number) => void;
}
```

Los bloques NO se conocen entre sí; solo dependen de `@video-factory/core` y `@video-factory/contracts`. La orquestación está en `apps/web/lib/pipeline.ts` (no en `packages/core`).

### 3.1 Bloques principales (en orden del pipeline rip de alta fidelidad)

| Block | Paquete | Qué hace |
|---|---|---|
| script-processor | `packages/blocks/script-processor/` | Limpia el guion, detecta pausas (`…`), divide en segmentos. |
| narrator-analyzer | `packages/blocks/narrator-analyzer/` | Detecta tipo de narrador (género, edad, profesión) desde guion + brand → CharacterCard. |
| tts-elevenlabs | `packages/blocks/tts-elevenlabs/` | Genera MP3 voz vía ElevenLabs. Voice selector elige voz por marca/género. |
| tts-openai *(alt)* | `packages/blocks/tts-openai/` | TTS alternativo (gpt-4o-mini-tts). |
| subtitles-google | `packages/blocks/subtitles-google/` | Subtítulos word-level vía Google Speech-to-Text. |
| scene-planner | `packages/blocks/scene-planner/` | Convierte ParsedScript en `SceneTrack[]` con imagePrompts vía Gemini. |
| scene-validator | `packages/blocks/scene-validator/` | **Validator V3** — valida cada imagen generada (anatomía, semántica, coherencia). Ver §6. |
| image-gen-imagen | `packages/blocks/image-gen-imagen/` | Providers de generación de imagen (OpenAI, Vertex Imagen, AI Studio Imagen, Higgsfield, fal). |
| image-gen-multi | `packages/blocks/image-gen-multi/` | Orquesta el chain de providers con validación + auto-regen. **Tiene el bug crítico de cascada — ver §7.** |
| video-gen-veo + kling | `packages/blocks/video-gen-veo/` | Image-to-video con Kling (primary) + Veo (fallback). |
| compositor-remotion | `packages/blocks/compositor-remotion/` | Render final MP4 con Remotion (audio + scenes + subtitles + composite layouts). |

### 3.2 Orquestación en `apps/web/lib/`

La orquestación de alto nivel NO está en `packages/core` — está en `apps/web/lib/`:

| Archivo | Qué hace |
|---|---|
| `pipeline.ts` | Orquesta el pipeline end-to-end. Construye el provider chain (líneas 326-389). Mete los blocks en orden. Persiste `scene-plan.json` y `render-job.json`. |
| `rip-fidelity-aligner.ts` | El "corazón" del modo Ripear: keyframe extraction, composite detection, scene-by-scene refinement loop. Threshold de fidelidad **80**. |
| `style-trainer.ts` | El "corazón" del modo Aprendizaje: extract keyframes, generar+comparar+iterar hasta converger, destilar preset. Threshold **92**. |
| `dynamic-preset-builder.ts` | Construye y persiste un PresetConfig a partir de un AdAnalysis (genera promptTemplate, classification, etc.). |
| `ad-analyzer.ts` | Análisis multimodal de un video vía Gemini 2.5 Pro (Vertex primary + AI Studio fallback). Genera `AdAnalysis` (paleta, escenas, narrador, hook, CTA). |
| `composite-layout-detector.ts` | Detecta si un keyframe es split-screen / grid / collage. Devuelve geometría exacta (rect %) por panel. Aprende de correcciones manuales (loop de aprendizaje). |
| `scene-reviewer.ts` | Validator semántico per-escena: idioma de texto burned-in, coherencia con narración, duplicación con escena anterior, producto visible, glifos rotos. |
| `scene-animator.ts` | Image-to-video por escena: **Kling primary** (si keys configuradas) + Veo fallback. Concurrencia 5. |
| `frame-extractor.ts` | Extrae keyframes equiespaciados de un video con ffmpeg. |
| `image-gen-tools.ts` | Helpers compartidos por `rip-fidelity-aligner` y `style-trainer`: provider chain builder + comparator Gemini Vision (single source of truth). |
| `ingredients-vision-refiner.ts` | Refina imagePrompts cuando la escena menciona un producto con asset físico (foto real de la marca). |
| `composition-memory.ts` *(en `packages/core`)* | Loop de aprendizaje: registra correcciones manuales del editor de composición. Future runs leen estos ejemplos para no repetir errores. |
| `error-memory.ts` *(en `packages/core`)* | Knowledge base de errores: cada vez que el Validator marca un fallo, se registra con categoría + keywords. Future runs lo consultan. |

---

## 4. El pipeline end-to-end (modo Ripeo fidelidad alta)

```
[Input: brand + preset + product + referenceVideo (opcional)]
  ↓
1. script-processor             → ParsedScript (segments + pause hints)
  ↓
2. narrator-analyzer            → CharacterCard (género, edad, etnia, profesión)
  ↓
3. tts-elevenlabs               → AudioTrack (mp3 + per-segment timing)
  ↓
4. subtitles-google             → SubtitleTrack (word-level)
  ↓
5. ad-analyzer                  → AdAnalysis (si hay referenceVideo)
  ↓
6. scene-planner                → SceneTrack[] (con imagePrompts)
  ↓
7. ingredients-vision-refiner   → SceneTrack refinado (productos reales)
  ↓
8. rip-fidelity-aligner         → SceneTrack con images por escena (alta fidelidad)
   (en modo Crear: image-gen-multi en su lugar)
  ↓
9. scene-validator V3 (post-batch sequence review opcional)
  ↓
10. scene-animator              → Scene[] con videoPath por escena (Kling/Veo)
  ↓
11. compositor-remotion         → final.mp4 (1080×1920, 30fps, H.264)
```

Outputs intermedios persistidos en `storage/runs/{runId}/`:
- `audio.mp3`
- `subtitles.json`
- `scene-plan.json` (SceneTrack completo)
- `scene_XX.png` por escena
- `scene_XX.mp4` por escena (animado, si aplica)
- `render-job.json`
- `final.mp4`

---

## 5. Providers externos en uso

| Proveedor | Para qué | Variable env | Estado |
|---|---|---|---|
| **OpenAI** | gpt-image-1 (imagen), Whisper (subs alt), TTS alt, gpt-image-1 análisis | `OPENAI_API_KEY` | Activo |
| **ElevenLabs** | TTS primary | `ELEVENLABS_API_KEY` | Activo |
| **Google AI Studio (Gemini API)** | Gemini 2.5 Flash (visión: detector/reviewer), Imagen 4 (fallback), Gemini Vision (comparator) | `GOOGLE_AI_API_KEY` | Activo, billing habilitado |
| **Google Cloud Speech-to-Text** | Subtítulos word-level (primary) | `GOOGLE_SPEECH_API_KEY` | Activo |
| **Google Cloud Vertex AI** | Imagen 4 (fast/std/ultra) — primary path actual; Gemini 2.5 Pro (ad-analyzer), Veo 3.1 Lite (video fallback) | `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | Activo pero **con bug de cuota** — ver §7 |
| **Higgsfield Cloud** | Flux Pro Kontext Max (image fallback) | `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET` | Activo |
| **Kling AI** | image-to-video (primary del scene-animator) | `KLING_ACCESS_KEY`, `KLING_SECRET_KEY` | Activo |
| **fal.ai** | Flux Pro / Dev (image fallback) | `FAL_API_KEY` | Opcional, sin configurar hoy |

**Provider chain de image-gen actual** (en `pipeline.ts:326-389`, orden de fallback automático):

```
1.   OpenAI gpt-image-1                  (primario)
2-4. Vertex AI Imagen (fast/std/ultra)
5-7. AI Studio Imagen (fast/std/ultra)
8.   Higgsfield Flux Pro Kontext Max
9-10. fal.ai Flux Pro / Dev              (si key configurada)
```

Cada provider implementa la interface `ImageProvider` (en `packages/blocks/image-gen-imagen/src/provider.ts`):

```typescript
export interface ImageProvider {
  readonly name: string;
  generate(req: ImageGenerationRequest): Promise<Buffer>;  // PNG
}

export class ImageProviderError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody: string,
    public retryable: boolean,
    public isDailyQuotaExhausted: boolean,
    public providerName: string,
    public isContentRejection: boolean = false,
  ) { /* ... */ }
}
```

Los flags `retryable`, `isDailyQuotaExhausted`, `isContentRejection` son los que GOBIERNAN la cascada — ver §7 para el bug.

---

## 6. El sistema VALIDATOR — "el cerebro que monitorea"

> El Validator es **una de las piezas clave** del sistema. No solo valida — es el cerebro que va a ir mejorando todo, monitoreando absolutamente todo, proponiendo mejoras, y previniendo que la IA suelte errores al pipeline.

### 6.1 Componentes actuales

#### `SceneValidatorV3` (`packages/blocks/scene-validator/`)
Validador per-escena. Llama a Gemini Vision con un cuestionario estructurado y devuelve:

```typescript
type V3ValidationResult = {
  verdict: 'pass' | 'regenerate' | 'fatal';
  score: number;          // 0-100
  issues: string[];       // problemas detectados
  refinementHint: string; // qué cambiar en el próximo intento
};
```

Categorías de problemas que detecta:
- **Anatomy** — manos con 4 dedos / 6 dedos / fusionadas, pies mal, caras asimétricas.
- **Body proportions** — cabeza más grande que el cuerpo, miembros desproporcionados.
- **Body part fusion** — dos brazos fusionados, etc.
- **Text gibberish** — texto burned-in ilegible (típico de gpt-image-1 con captions).
- **Numbers illogical** — calendarios con días al azar, números sin sentido.
- **Illogical visual elements** — símbolos infinity flotantes, geometrías raras.
- **Semantic mismatch** — la imagen no coincide con la narración.
- **Character mismatch** — el personaje difiere del narratorProfile esperado.
- **Style break** — la escena rompe el styleBase del preset.

Cuando devuelve `regenerate`, el block que lo invocó (image-gen-multi o rip-fidelity-aligner) usa el `refinementHint` para construir el próximo prompt y reintentar.

#### `SceneSequenceValidator` (`packages/blocks/scene-validator/`)
Validator de SECUENCIA — corre POST-batch, manda las N imágenes generadas JUNTAS a Gemini Vision multimodal y detecta:
- Continuidad de personaje cross-scene.
- Saltos abruptos de estilo.
- Problemas que solo son visibles en conjunto.
- Flag de escenas para regenerar con un hint de secuencia.

#### `scene-reviewer.ts` (en `apps/web/lib/`)
Validator semántico complementario. Detecta:
- Texto burned-in en idioma incorrecto.
- Duplicación con escena anterior (frames repetidos).
- Producto NO visible cuando la escena lo menciona.
- Coherencia con narración.
- Composite alucinado cuando se esperaba single-shot.

Modela el patrón "fail-open con logging visible" — cuando la API de visión está caída, devuelve `pass` (no rompe el rip) pero registra el fallo en logs (`scene-reviewer:fallback_*`) para visibilidad.

#### `composite-layout-detector.ts`
Detecta si un keyframe del video original es split-screen / grid / collage. Si lo es, devuelve la geometría exacta (`rect: {x, y, w, h}` en %) de cada panel. El `rip-fidelity-aligner` lo usa para generar cada panel por separado en vez de pedirle al generador un grid alucinado.

**Loop de aprendizaje:** el detector consulta `composition-memory.ts` (que registra correcciones manuales del editor de composición) y las inyecta como ejemplos few-shot en su prompt → con cada edición manual del usuario, el modo automático mejora.

### 6.2 Auto-correcciones implementadas

El sistema de validación auto-corrige proactivamente:

| Problema detectado | Acción |
|---|---|
| Imagen falla validación (score < 75) | Regenera con `refinementHint` como adjustment crítico |
| Burned-in text alucinado | Inyecta directiva ALL-CAPS NO TEXT al INICIO del próximo prompt (los image gens respetan más las primeras instrucciones) |
| Composite alucinado por gpt-image-1 (típico con presets learned) | Inyecta directiva "ONE SINGLE PHOTOGRAPHIC FRAME — NOT split-screen, NOT grid…" al inicio |
| Composite alucinado persistentemente (todos los attempts) | **Auto-escalado a composite real** — deja de pelear, detecta el layout en la imagen generada, y regenera cada panel por separado |
| Anatomy issues (manos, dedos, etc.) | Regenera con hint anatómico explícito + cambio de modelo (RETRY_MODEL si está configurado) |
| Provider 429 quota exhausted | (Idealmente — ver §7) salta al próximo provider de la chain |
| Content rejection (safety filter) | Sanitiza el prompt con un safety constraint y reintenta; último resort → safe placeholder abstract |
| Imagen no se pudo generar en ningún provider | Persiste un PNG 1×1 negro placeholder para no romper el pipeline downstream |

### 6.3 Visión: el Validator como "cerebro que mejora"

La intención de fondo (a desarrollar progresivamente):
- **Monitorear absolutamente todo** — no solo escenas individuales sino el pipeline completo, telemetría per-provider, performance, costo, latencia.
- **Proponer mejoras** — cuando detecta patrones de fallo recurrentes (ej. preset X tiene 30% rejection rate por OpenAI), sugerir cambios automáticos al preset.
- **Aprender de las correcciones manuales** — ya existe parcialmente en `composition-memory.ts` para el editor de composición; expandir a otras correcciones del usuario.
- **Auditoría automática post-rip** — analizar el video terminado y reportar puntos de mejora.

Esto es **roadmap, no estado actual.** Hoy el Validator es defensivo (detecta y reacciona). El próximo nivel es proactivo (anticipa y propone).

---

## 7. El bug crítico de cascada multi-provider

### 7.1 El problema

Hoy, cuando un proveedor de imagen falla con 429 (cuota), el sistema **NO salta al próximo proveedor**. Se queda reintentando el mismo 5 veces con backoff y muere. Esto es lo que tumbó el rip de prueba reciente:

```
Error generando imágenes (multi): Vertex Imagen 429 Too Many Requests:
  "code": 429,
  "message": "Quota exceeded for online_prediction_requests_per_base_model"
```

### 7.2 Causa raíz

`VertexImagenProvider` (`packages/blocks/image-gen-imagen/src/vertex-provider.ts:142-156`) marca `isDailyQuotaExhausted=false` SIEMPRE. La cascada en `ImageGenMultiBlock` (`packages/blocks/image-gen-multi/src/block.ts:244-353`) solo salta de step cuando ese flag está `true`. Sin el flag, retry-loop hasta agotar `MAX_API_RETRIES=5`, y throw — los providers downstream (Higgsfield, fal) **nunca son probados**.

### 7.3 Plan de fix

Detallado en `investigacion/01-image-gen-multi-block-analysis.md` y consolidado en `investigacion/99-PLAN-FINAL.md`. Resumen:

1. **Bug 1**: hacer que `VertexImagenProvider` parsee el body del 429 y, si contiene `online_prediction_requests_per_base_model`, setear `isDailyQuotaExhausted=true` → la cascada salta al próximo provider en el primer intento.
2. **Bug 2 (red de seguridad)**: en el block, cuando `MAX_API_RETRIES` se agota en un error retryable, tratar el step como exhausto (no throw) y probar el próximo. Cubre cualquier provider que no detecte quota correctamente.
3. **Throttling per-provider** con Bottleneck — para que no causemos nosotros el 429 disparando 22 requests en paralelo.
4. **Logging visible del cascading** para diagnóstico.

### 7.4 Implicaciones de futuro

El plan más amplio (en `investigacion/99-PLAN-FINAL.md` + `EXT-claude-research.md`) incluye:

- **Migrar a Gemini 2.5 Flash Image ("Nano Banana") como primario** — cuota independiente de Vertex Imagen, y además **Imagen 4 muere el 24 jun 2026** según deprecation de Google.
- **Agregar BFL Flux 2 Pro direct, Recraft V3, Ideogram V3** al chain para diversificar.
- **Cockatiel** (Microsoft) para retry + circuit breaker + bulkhead.
- **Ruteo del chain por estilo de preset** — ilustración va a Gemini primero, photoreal a OpenAI, médico/pediátrico nunca a OpenAI.
- **Multi-region Vertex fan-out** (us-central1 + europe-west2) para doblar effective RPM.
- **Crear un proyecto GCP nuevo manual** — el `gen-lang-client-*` actual tiene bug documentado de billing-sync.
- **Resume-from-stage** + **fallback frames** + **telemetría `modelAttempts[]`** estilo Vercel AI Gateway.

---

## 8. Taxonomía de perfiles de video

> **El sistema necesita evolucionar de "un pipeline para todo" a "N perfiles, cada uno con su receta de producción óptima"**. Cada perfil = (categoría + sub-categoría) = pipeline-recipe específica.

### 8.1 Modelo mental

Un **perfil de video** es una recipe que declara:

```typescript
type VideoProfile = {
  id: string;                       // 'broll-anim-pixar', 'ugc-real-avatar', etc.
  categoria: 'broll' | 'ugc' | 'composiciones-complejas' | 'vsl';
  subcategoria: string;             // 'anim-pixar', 'anim-acuarela', 'real-foto', etc.

  pipelineModules: PipelineModule[]; // qué etapas correr y en qué orden
  providerChains: {
    imageGen: ProviderChain;        // primary/fallback per stage
    animator?: ProviderChain;
    avatar?: ProviderChain;
    // ...
  };
  visualStyle: VisualStyleConfig;
  costTarget: number;               // USD por rip
  latencyTarget: number;            // minutes
  validatorConfig: ValidatorConfig; // qué tan estricto
};
```

Hoy, los presets en `packages/presets/*.preset.json` declaran visualStyle + algunos campos, pero **no declaran la pipeline-recipe completa**. La pipeline está hardcodeada en `pipeline.ts`. **Hay que cambiar eso.**

### 8.2 Taxonomía inicial propuesta

| Cat | Sub-cat (ID propuesto) | Qué es |
|---|---|---|
| **B-ROLL** | `broll-anim-pixar` | 3D animado estilo Pixar |
| | `broll-anim-acuarela` | Comic/acuarela sepia (preset `doctor_broll_animado_comic_sepia` actual) |
| | `broll-real-foto` | Humanos/escenas foto-realistas con motion |
| | `broll-real-stock` *(potencial)* | B-roll de stock footage real + edición |
| **UGC** | `ugc-anim-pixar` | Avatar animado Pixar hablando |
| | `ugc-anim-acuarela` | Avatar ilustrado hablando |
| | `ugc-real-avatar` | Avatar humano realista (HeyGen/Tavus/Arcads) hablando |
| **COMPOSICIONES COMPLEJAS** | `complex-collage` | N imágenes en collage editado tipo CapCut |
| | `ugc-greenscreen-explica` | UGC real persona con backgrounds de imágenes (doctor opinando, reseña de marca) |
| **VSL** | `vsl-tipo-A`, `vsl-tipo-B`, ... | Por definir con el owner |

### 8.3 Detalle por perfil — pending de investigación específica

La investigación inicial cubrió la **infraestructura base** (cascada robusta, providers de imagen, etc.). Para CADA PERFIL hay que investigar el stack óptimo específico — research pendiente por hacer:

- **`ugc-real-avatar`** — providers HeyGen / Tavus / Arcads / Synthesia / Creatify. **No investigados aún.**
- **`complex-collage`** — patrones de collage programático en Remotion + composición pixel-perfect.
- **`ugc-greenscreen-explica`** — chroma key automation en Remotion + integración de UGC real grabado con backgrounds.
- **`broll-anim-pixar`** — qué image-gen + animator dan el look 3D Pixar específico (vs ilustración 2D acuarela).
- **`broll-real-stock`** — APIs de stock (Pexels, Pixabay, Wikimedia) + edición.
- **`vsl-tipos`** — taxonomía canónica de VSL en ecommerce D2C (testimonial, problem-solution, founder-story, etc.).

Cada perfil tendrá su propio doc en `investigacion/perfiles/{id}.md` cuando se investigue.

---

## 9. Sistema de aprendizaje de estilos

> El modo Aprendizaje es lo que hace el sistema "vivo" — la biblioteca de presets crece a medida que el usuario carga videos.

### 9.1 Flujo end-to-end

`apps/web/lib/style-trainer.ts:trainStyle()`:

1. **Análisis multimodal** del video con Gemini 2.5 Pro (vía `ad-analyzer.ts`) → `AdAnalysis` con paleta, escenas, narrador, hook, CTA, línea editorial.
2. **Extract keyframes** equiespaciados (típicamente 5-7) con ffmpeg.
3. **Loop iterativo por keyframe** (max 5 iteraciones cada uno):
   - Construye prompt desde el `AdAnalysis` + scene description.
   - Genera imagen vía provider chain.
   - Compara vs keyframe original con Gemini Vision → `{score 0-100, hint}`.
   - Si `score >= 92` (SIMILARITY_THRESHOLD), keyframe converge.
   - Si no, refina prompt con `CRITICAL ADJUSTMENT: {hint}` y reintenta.
4. **Construye preset destilado** vía `dynamic-preset-builder.ts`:
   - Genera `promptTemplate`, `negativePrompt`, `classification`, `visualStyle`.
   - Persiste en `packages/presets/pending/{id}.preset.json` con prefijo `learned-`.
   - Tag "🎓 Entrenado" en el displayName.
5. **Extract "ideas generales"** — Gemini extrae 4-6 insights transferibles (no resumen literal, sino principios).
6. **Persiste trajectory** en DB (`trainingVideos` table) — el frontend pollea cada 2s para mostrar iteraciones en vivo.

### 9.2 UI del modo

`/aprendizaje` muestra:
- Drag-drop / upload del video.
- En vivo durante el training: cada iteración por keyframe (imagen generada vs original + score + hint).
- Al final: el preset destilado para review + las "ideas generales" + botón "Aprobar" que mueve el preset de `pending/` a la biblioteca activa.

La aprobación se hace desde `/admin` (sección de presets pending).

### 9.3 Integración con Crear/Ripear

Los presets aprobados aparecen en el dropdown de presets de `/create` y `/rip`. Cada preset aprendido es REUTILIZABLE para producir nuevos videos con ese estilo, adaptados a productos diferentes.

---

## 10. Feature de Sugerencias (NUEVO)

### 10.1 Qué es

Una entrada en el menú superior **"Sugerencias"** (junto a Crear / Ripear / Aprendizaje / etc.) donde el operador puede dejar **ideas de mejora o feedback** mientras usa la herramienta. Estas sugerencias:

- Se guardan en una **carpeta interna** del proyecto (`storage/sugerencias/` por default — local-only).
- **NO se aplican automáticamente.** Solo se persisten para revisión humana.
- El owner puede revisarlas cuando quiera y decidir cuáles implementar.

### 10.2 Implementación esperada

- **Page route:** `apps/web/app/(app)/sugerencias/page.tsx`
- **API route:** `apps/web/app/api/sugerencias/route.ts` (POST handler)
- **Storage:** `storage/sugerencias/{timestamp}-{uuid}.json`
- **Schema:** `{ id, createdAt, title, description, contextUrl?, tags?, author? }`
- **Menu link:** agregar `<Link href="/sugerencias">Sugerencias</Link>` en `apps/web/app/(app)/layout.tsx`.

### 10.3 Cómo se consume

Cuando el owner quiera revisarlas, puede:
- Ver la carpeta `storage/sugerencias/` directamente.
- (Futuro) un endpoint GET `/api/sugerencias` que lista todas con search/filter.
- (Futuro) un view dentro de `/admin` que las muestre ordenadas.

Por ahora MVP es: el form que persiste el JSON. La UI de consumo se construye después si el volumen lo justifica.

---

## 11. Estado actual y errores conocidos

### 11.1 Lo que funciona

- ✅ Pipeline end-to-end de Crear (script → MP4).
- ✅ Pipeline end-to-end de Ripear (referenceVideo + script → MP4) — incluyendo composite detection, panel-per-panel generation, anti-hallucination.
- ✅ Modo Aprendizaje completo (video → preset destilado).
- ✅ Editor de composición en `/runs/[id]/editor` (drag/resize/rotate por elemento + re-render).
- ✅ Loop de aprendizaje del editor (`composition-memory.jsonl`).
- ✅ Scene-animator con Kling primary + Veo fallback.
- ✅ Validator V3 (anatomía + semántica + secuencia).
- ✅ Multi-marca (Vitaly + esquema extensible).

### 11.2 Bugs conocidos / WIP

| Issue | Severidad | Estado | Doc |
|---|---|---|---|
| **Cascada multi-provider no salta tras 429 de Vertex Imagen** | 🔴 Crítico | Plan armado, no implementado | `investigacion/01-image-gen-multi-block-analysis.md` + `99-PLAN-FINAL.md` |
| **Imagen 4 EOL 24 jun 2026** — migración obligatoria a Nano Banana | 🟡 Alto (deadline) | Plan armado | `investigacion/EXT-claude-research.md` |
| **Proyecto `gen-lang-client-*` con billing-sync bug** | 🟡 Alto | Plan: crear proyecto manual | `investigacion/05-vertex-quota-strategy.md` |
| **HANDOFF.md tiene diagnóstico de billing incorrecto** (decía "billing no habilitado", en realidad SÍ está) | 🟢 Bajo (cosmético) | Pendiente corregir | Task #5 |
| **Falta resume-from-stage** — un rip que falla a mitad pierde todo | 🟢 Medio (UX) | Plan armado | `investigacion/08-similar-tools-analysis.md` |
| **OpenAI gpt-image-1 rechaza contenido pediátrico/médico** | 🟢 Medio | Mitigado por cascada + plan: ruteo por preset evita OpenAI en sensitive | `investigacion/06-content-policy-strategies.md` |

### 11.3 Limitaciones de diseño actuales

- **Pipeline único hardcodeado** — todos los presets pasan por el mismo `pipeline.ts`. El plan de perfiles (§8) lo cambia.
- **Sin telemetría per-provider** — no se ve cuál proveedor generó cada escena. Plan: `modelAttempts[]` shape estilo Vercel AI Gateway.
- **Throttling solo global** (`MIN_INTERVAL_MS=6500` en `image-gen-multi`), no per-provider.
- **Storage local** — runs y artifacts viven en `storage/` del operador. Multi-operador requeriría storage compartido.
- **Sin avatar UGC realista** — el `scene-animator` hace image-to-video pero no avatar persistente con lip-sync para UGC tipo HeyGen/Tavus.
- **Sin composiciones complejas tipo CapCut** — el compositor-remotion soporta composite layouts (grids) pero no edición avanzada estilo collage + green screen + transiciones complejas.

---

## 12. Plan de evolución

### 12.1 Infraestructura base (alta prioridad)

Detallado en `investigacion/99-PLAN-FINAL.md`. Resumen:

1. **Arreglar bug de cascada** (Bug 1 + Bug 2 del análisis). [1 día]
2. **Agregar `GeminiNanoBananaProvider`** (modelo `gemini-2.5-flash-image`) como nuevo primary. [1 día]
3. **Throttling per-provider con Bottleneck.** [0.5 día]
4. **Telemetría `modelAttempts[]`** en la tabla `runs`. [0.5 día]
5. **Resume-from-stage** — leer `currentStep` de la DB y reanudar. [0.5 día]
6. **Fallback frames** cuando todos los providers fallan. [0.5 día]
7. **Pedir aumento de cuota Vertex** (form de Google). [10 min, background]
8. **Ruteo del chain por estilo de preset** (mejora opcional). [1 día]

Total: ~4 días de implementación → rip robusto que no requiere intervención manual.

### 12.2 Sistema de perfiles (mediano plazo)

1. **Schema de `VideoProfile`** (campo `pipelineModules`, `providerChains`, etc.).
2. **Migración de presets actuales** al nuevo schema.
3. **Pipeline runtime dispatcher** — lee el perfil del preset y arma la pipeline dinámicamente (en vez de hardcoded `pipeline.ts`).
4. **Per-perfil research** (cada uno tendrá su propio doc en `investigacion/perfiles/`).
5. **Nuevos providers según perfil:**
   - HeyGen / Tavus / Arcads para `ugc-real-avatar`.
   - Stock APIs (Pexels, Pixabay) para `broll-real-stock`.
   - Recraft V3 / Ideogram V3 para sub-perfiles específicos.

### 12.3 Validator como cerebro (largo plazo)

1. **Auditoría automática post-rip** — análisis del MP4 final + recomendaciones.
2. **Aprendizaje cross-preset** — si preset X tiene 30% rejection en OpenAI, sugerir cambio automático al chain.
3. **Telemetry dashboard** — métricas per-provider, costos, latencia, success rate.
4. **Propuestas proactivas** — el Validator sugiere mejoras concretas al owner.

### 12.4 Features de UX (mediano plazo)

- **SSE streaming de progreso al UI** (patrón Backblaze) — ver provider/scene/timing en vivo.
- **Feature de Sugerencias** (§10).
- **Re-render granular** desde el editor (parcial existe).
- **Comparison view** lado-a-lado de rip vs reference (para auditar fidelity).

---

## 13. Estructura del repositorio

```
video-factory/
├── ARQUITECTURA.md                   ← este doc — visión completa del sistema
├── HANDOFF.md                        ← estado de la sesión más reciente
├── DOCUMENTO_MAESTRO.md              ← spec v1 original (obsoleto, referencia histórica)
├── README.md                         ← setup técnico breve
├── ONBOARDING.md                     ← guía para colaboradores nuevos
├── CLAUDE.md                         ← reglas para AI assistants (Claude Code)
│
├── apps/
│   └── web/                          ← Next.js 14 (UI + API)
│       ├── app/
│       │   ├── (app)/
│       │   │   ├── layout.tsx        ← navbar con Crear/Ripear/Aprendizaje/Videos/Marcas/Admin
│       │   │   ├── create/           ← formulario "Crear video desde guion"
│       │   │   ├── rip/              ← formulario "Ripear video de referencia"
│       │   │   ├── aprendizaje/      ← formulario "Aprender estilo desde video"
│       │   │   ├── runs/             ← lista de runs + detalle + editor de composición
│       │   │   │   ├── page.tsx
│       │   │   │   ├── trash/
│       │   │   │   └── [id]/
│       │   │   │       ├── page.tsx
│       │   │   │       ├── RunViewer.tsx
│       │   │   │       ├── CorrectionPanel.tsx
│       │   │   │       └── editor/             ← editor visual de composite layouts
│       │   │   │           ├── page.tsx
│       │   │   │           └── CompositionEditor.tsx
│       │   │   ├── brands/           ← config de marcas
│       │   │   ├── admin/            ← aprobación de presets pending
│       │   │   └── sugerencias/      ← (NUEVO, ver §10)
│       │   ├── api/
│       │   │   ├── auth/             ← login con APP_PASSWORD
│       │   │   ├── generate/         ← Crear: dispara pipeline
│       │   │   ├── rip/[id]/rip/     ← Ripear: dispara pipeline con referenceVideo
│       │   │   ├── runs/[id]/...     ← lectura/escritura per-run (composition, scene-asset, rerender, retry, etc.)
│       │   │   ├── training/         ← Aprendizaje
│       │   │   ├── presets/          ← CRUD presets
│       │   │   ├── brands/           ← CRUD brands
│       │   │   ├── admin/            ← endpoints admin
│       │   │   └── sugerencias/      ← (NUEVO)
│       │   └── page.tsx              ← landing / login
│       ├── lib/                      ← ⭐ ORQUESTACIÓN — lógica de alto nivel
│       │   ├── pipeline.ts                       ← orquesta el end-to-end
│       │   ├── rip-fidelity-aligner.ts           ← modo Ripear
│       │   ├── style-trainer.ts                  ← modo Aprendizaje
│       │   ├── dynamic-preset-builder.ts         ← destila preset desde AdAnalysis
│       │   ├── ad-analyzer.ts                    ← análisis multimodal Gemini 2.5 Pro
│       │   ├── composite-layout-detector.ts      ← detecta grids/split-screens
│       │   ├── scene-reviewer.ts                 ← validator semántico
│       │   ├── scene-animator.ts                 ← Kling/Veo image-to-video
│       │   ├── image-gen-tools.ts                ← provider chain + comparator (shared)
│       │   ├── correction-pipeline.ts            ← correcciones por escena
│       │   ├── single-image-fallback.ts          ← single-image fallback path
│       │   ├── ingredients-vision-refiner.ts     ← refina prompts con assets de marca
│       │   ├── preset-preview-generator.ts       ← preview de presets
│       │   ├── script-suggester.ts               ← sugerencias de guion
│       │   ├── runs-repository.ts                ← acceso DB de runs
│       │   ├── brand-ingredients-store.ts        ← assets de marca
│       │   ├── admin-presets-store.ts            ← presets pending
│       │   ├── cost-tracker.ts                   ← contabilidad de costos por rip
│       │   ├── frame-extractor.ts                ← ffmpeg keyframes
│       │   ├── ffmpeg-locator.ts                 ← resolve ffmpeg binary
│       │   ├── rerender-composition.ts           ← re-render solo compositor (rápido)
│       │   └── db.ts, paths.ts, brand-preset-loader.ts, etc.
│       ├── components/               ← React components (incluido ErrorCollector)
│       └── middleware.ts             ← auth check
│
├── packages/
│   ├── core/                         ← interfaces Block + Pipeline + utilities
│   │   └── src/
│   │       ├── block.ts              ← Block<I,O>, BlockError, BlockContext
│   │       ├── pipeline.ts           ← Pipeline orchestrator
│   │       ├── error-memory.ts       ← KB de errores
│   │       ├── composition-memory.ts ← KB de correcciones manuales
│   │       └── index.ts
│   ├── contracts/                    ← schemas Zod compartidos
│   │   └── src/
│   │       ├── brand.schema.ts
│   │       ├── preset.schema.ts
│   │       ├── script.schema.ts
│   │       ├── scene.schema.ts       ← Scene, SceneTrack, CompositeElement, CompositeLayout, SubScene
│   │       ├── audio.schema.ts
│   │       ├── subtitle.schema.ts
│   │       ├── render.schema.ts
│   │       ├── ad-analysis.schema.ts
│   │       └── index.ts
│   ├── blocks/
│   │   ├── script-processor/
│   │   ├── narrator-analyzer/
│   │   ├── tts-elevenlabs/
│   │   ├── tts-openai/
│   │   ├── subtitles-google/
│   │   ├── scene-planner/
│   │   ├── scene-validator/          ← ⭐ V3 + SequenceValidator
│   │   ├── image-gen-imagen/         ← providers: OpenAI, Vertex, Google, Higgsfield, Fal
│   │   ├── image-gen-multi/          ← chain orchestrator (con el bug crítico)
│   │   ├── video-gen-veo/            ← Kling + Veo clients
│   │   └── compositor-remotion/      ← Remotion compositions
│   ├── presets/                      ← biblioteca de presets
│   │   ├── _schema.json
│   │   ├── *.preset.json             ← presets activos
│   │   └── pending/                  ← presets aprendidos sin aprobar
│   │       └── *.preset.json
│   ├── brands/                       ← config de marcas
│   │   ├── _schema.json
│   │   └── vitaly.brand.json
│   └── ui/                           ← React shared
│
├── db/
│   ├── schema.ts                     ← Drizzle schema (runs, training_videos, rips, etc.)
│   ├── local.db                      ← SQLite (gitignored)
│   └── migrations/
│       ├── 0001_*.sql
│       ├── 0002_repository_and_cost.sql
│       ├── 0003_rips_table.sql
│       └── 0004_training_videos.sql
│
├── docs/                             ← documentación de referencia
│   ├── analisis_videos_referencia.md
│   ├── analisis_videos_ugc.md
│   ├── instrucciones_cowork.md
│   └── sources/                      ← videos de referencia, briefs (gitignored)
│
├── investigacion/                    ← research + planes de evolución
│   ├── 00-INDEX.md
│   ├── 01-image-gen-multi-block-analysis.md
│   ├── 02-gemini-image-api.md
│   ├── 03-provider-comparison.md
│   ├── 04-resilience-patterns-ts.md
│   ├── 05-vertex-quota-strategy.md
│   ├── 06-content-policy-strategies.md
│   ├── 07-opensource-references.md
│   ├── 08-similar-tools-analysis.md
│   ├── 99-PLAN-FINAL.md              ← plan consolidado de infraestructura
│   ├── EXT-claude-research.md        ← respuesta de Claude Deep Research
│   ├── EXT-claude-research-raw.txt
│   └── perfiles/                     ← (FUTURO) un doc por perfil de video
│
├── storage/                          ← gitignored (artifacts generados)
│   ├── runs/{runId}/                 ← audio, scenes, final.mp4
│   ├── composition-memory/           ← corrections.jsonl
│   └── sugerencias/                  ← (NUEVO, ver §10)
│
└── scripts/                          ← scripts ad-hoc (probes, smoke tests, migrations)
```

---

## 14. Cómo navegar el código para Claudes futuros

### 14.1 Orden de lectura recomendado

1. **Este archivo** (`ARQUITECTURA.md`) — visión completa.
2. **`HANDOFF.md`** — estado de la sesión actual (qué se está trabajando, qué está bloqueado).
3. **`investigacion/99-PLAN-FINAL.md`** — plan de evolución de la infraestructura.
4. **`investigacion/EXT-claude-research.md`** — research externa que complementa.
5. Si vas a tocar la cascada o providers: `01-image-gen-multi-block-analysis.md`.
6. Si vas a tocar perfiles: la taxonomía está en §8 de este doc; los perfiles individuales viven en `investigacion/perfiles/`.

### 14.2 Reglas inviolables

1. **Tipescript strict** — sin `any` sin justificación.
2. **Input/output de bloques validado con Zod.**
3. **Errores tipados** con `Result<T, BlockError>` (neverthrow).
4. **Logs con `pino` + `runId`.**
5. **Bloques NO se conocen entre sí** — solo dependen de `core` y `contracts`.
6. **Presets y marcas son JSON**, NUNCA en TypeScript.
7. **NO commitear archivos generados** — `storage/`, `db/local.db`, `.env` están en `.gitignore`.
8. **NO actualizar git config** desde un agente.
9. **Idioma del output al usuario:** español neutro (formas con "tú", sin argentinismos).
10. **Tras editar `apps/web/lib/*.ts`:** reiniciar `pnpm dev` (Next.js cachea módulos server).
11. **NO commitear ni correr operaciones destructivas sin pedirlo explícitamente.**
12. **NO tocar `DOCUMENTO_MAESTRO.md`** sin permiso explícito del owner (es histórico, congelado).

### 14.3 Variables de entorno requeridas

Todas en `.env` (gitignored). Ver `.env.example` para la lista completa con comentarios y dónde obtener cada key. Resumen:

- `APP_PASSWORD` (login local)
- `OPENAI_API_KEY` (gpt-image-1, Whisper)
- `ELEVENLABS_API_KEY` (TTS)
- `GOOGLE_AI_API_KEY` (Gemini API: visión + Imagen)
- `GOOGLE_SPEECH_API_KEY` (Speech-to-Text)
- `GCP_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS` (Vertex AI)
- `HIGGSFIELD_KEY_ID` + `HIGGSFIELD_KEY_SECRET` (Flux Pro Kontext)
- `KLING_ACCESS_KEY` + `KLING_SECRET_KEY` (image-to-video)
- `FAL_API_KEY` (opcional, fallback)
- `DATABASE_URL`, `LOG_LEVEL`, etc.

### 14.4 Comandos clave

```bash
pnpm install
pnpm db:migrate
pnpm --filter '@video-factory/web' dev    # localhost:3000
pnpm -r typecheck                          # type-check completo
pnpm format                                # Prettier
```

### 14.5 Cuando algo no funciona

- **Pipeline cae en "Error generando imágenes (multi): Vertex Imagen 429"** → bug conocido de cascada (§7). Plan en `investigacion/99-PLAN-FINAL.md`.
- **`pnpm dev` parece correr código viejo tras editar `lib/*.ts`** → Next.js cachea módulos server. Reiniciar.
- **Imagen rechazada por OpenAI con error 400** → safety filter. La cascada debería saltar al próximo provider (cuando el bug esté arreglado). Por ahora, probar con un preset que no use OpenAI primary.
- **Run viejo no abre el editor de composición** (`/runs/{id}/editor` da 404) → es esperado: la persistencia de `scene-plan.json` se agregó tardíamente. Solo runs nuevos lo tienen.

---

## 15. Próximos pasos prioritarios

En orden de impacto:

1. **Arreglar bug de cascada (Bug 1 + Bug 2)** — sin esto los rips siguen muriendo. `investigacion/99-PLAN-FINAL.md` paso 1.
2. **Agregar `GeminiNanoBananaProvider`** y meterlo de primary. Plan paso 2.
3. **Throttling per-provider** con Bottleneck. Plan paso 3.
4. **Construir Feature de Sugerencias** (§10) — pendiente en este mismo trabajo, task #13.
5. **Definir el schema de `VideoProfile`** (§8.1) y migrar presets actuales.
6. **Investigar perfiles que aún no tienen doc:** `ugc-real-avatar`, `complex-collage`, `ugc-greenscreen-explica`, `vsl-tipos`.
7. **Corregir el diagnóstico de billing en `HANDOFF.md`** (task #5 — el HANDOFF dice que falta billing pero ya está habilitado).
8. **Implementar `modelAttempts[]` telemetry** estilo Vercel AI Gateway en la tabla `runs`.

---

## 16. Glosario rápido

- **Rip / Ripear** — modo de operación que toma un video referencia y lo replica adaptado al producto.
- **Preset** — config visual + estilo + parámetros para un tipo de video.
- **Brand** — config de una marca propia (Vitaly, Nelo) — voz default, productos, paleta, tono.
- **SceneTrack** — array ordenado de escenas con timing, prompts, imágenes, subtitulos.
- **CompositeLayout** — split-screen / grid / collage detectado en una escena. Cada panel se genera por separado.
- **CompositeElement** — geometría libre (`rect {x,y,w,h}` en %) de un elemento dentro de una escena. Permite composiciones no-grid.
- **Validator V3** — el sistema de validación per-escena (anatomía, semántica, etc.).
- **Comparator** — Gemini Vision comparando una imagen generada vs un keyframe original; devuelve score 0-100 + hint.
- **Provider chain** — secuencia ordenada de providers de imagen con fallback automático.
- **Cascada** — la lógica de "si falla, salta al próximo" — hoy rota, ver §7.
- **Throttling** — limitar la tasa de requests a un provider (per-minute, etc.).
- **Telemetría `modelAttempts[]`** — registro detallado per-escena de qué providers se intentaron, en qué orden, con qué resultado.
- **Perfil** *(propuesta)* — recipe completa de producción para un tipo específico de video (B-roll Pixar, UGC avatar real, VSL tipo A, etc.).
- **Sugerencias** *(nuevo, §10)* — formulario interno donde el operador deja ideas de mejora; se persisten sin auto-aplicarse.

---

**Fin del documento maestro.**

*Si tenés que actualizarlo: hacelo al final de una sesión grande, junto al `HANDOFF.md`. No lo congeles como `DOCUMENTO_MAESTRO.md` — está pensado para vivir y evolucionar.*
