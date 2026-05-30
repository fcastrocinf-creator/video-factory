# EXT — Claude Deep Research

> **Fuente:** PDF "Video Factory Image Generation_ Multi-Provider Cascade and Nano Banana Migration Plan.pdf" entregado por el usuario (2026-05-23).
> Generado por Claude Deep Research a partir del brief que armé en `99-PLAN-FINAL.md` (versión previa) + investigación propia con citas externas.
>
> **Este documento es contenido externo verbatim** (reformateado para legibilidad). NO es mi análisis; está separado a propósito para no mezclarse con `01-07` y `99`. La síntesis y diff con mi plan va en `08-sintesis-claude-vs-mi-plan.md` (pendiente).
>
> **Texto crudo original:** `EXT-claude-research-raw.txt` (extracción `pdftotext` UTF-8).

---

## TL;DR

Reemplazar la dependencia de Imagen 4 con **Gemini 2.5 Flash Image ("Nano Banana")** como primario, mantener **BFL Flux 2 Pro y fal.ai** como fallbacks resilientes, y demote OpenAI gpt-image-1 a carril secundario.

Imagen 4 está programado para apagarse el **24 de junio de 2026** (per la página de deprecaciones de Gemini API / Firebase rate-limits doc, actualizada 2026-05-19: *"All Imagen models will shut down on June 24, 2026. Learn about migrating your apps to use Nano Banana."*) e Imagen 4 todavía usa la cuota legacy per-base-model RPM que es exactamente lo que está rompiendo los rips hoy.

Arreglar la cascada separando **"retry within provider"** de **"fail-over to next provider"**, manejado por clasificación de errores (`quota-exhausted`, `content-rejection`, `transient`). Implementar con **cockatiel** (retry + circuit-breaker + bulkhead) + **bottleneck** (per-provider RPM/IPM token-bucket). Tratar los 429 per-base-model como señal de circuit-open — nunca iterar dentro de otros modelos del mismo provider en error de cuota.

Agregar Nano Banana (Gemini API, paid Tier 1 = 10 IPM con billing habilitado; pool de cuota independiente de Vertex Imagen) y rutear por estilo de preset (photoreal → Nano Banana / Flux 2 Pro; illustration/comic → Recraft V3 o Ideogram 3; medical/pediatric → Nano Banana primero, NUNCA gpt-image-1).

---

## Key Findings

### A. La cascada actual está rota porque los errores no se clasifican

Vertex AI retorna 429 con la métrica `aiplatform.googleapis.com/online_prediction_requests_per_base_model` cuando la cuota RPM per-minute para ese Imagen base model específico se agota. El pipeline actual itera Vertex fast → std → ultra dentro del mismo proyecto, pero **los tres comparten el mismo envelope de cuota a nivel proyecto** e Imagen 4 NO está en la lista de **Dynamic Shared Quota (DSQ)** de Google.

(`cloud.google.com/vertex-ai/generative-ai/docs/resources/dynamic-shared-quota` enumera solo Gemini models; Imagen 4 sigue usando el sistema legacy per-base-model RPM.) Cuando fast 429ea, std y ultra también 429earán en segundos — la cascada DEBE saltar a un proveedor distinto, no a otro SKU de Imagen.

### B. Imagen 4 tiene fecha de end-of-life

La página de deprecations de Gemini API (surfacing en el Firebase AI Logic rate-limits doc, actualizado 2026-05-19) dice:
> *"All Imagen models will shut down on June 24, 2026. Learn about migrating your apps to use Nano Banana."*

Eso hace que la pelea de cuota Vertex Imagen sea un problema **temporal** — el movimiento estratégico es migrar el carril primario a Nano Banana ya.

### C. Nano Banana es el primario correcto

- **Model ID (Gemini API & Vertex):** `gemini-2.5-flash-image` (generally available desde 2 oct 2025).
- El preview alias `gemini-2.5-flash-image-preview` fue apagado el **15 enero 2026** — no usarlo.
- **Pricing:** $0.039 por imagen 1024-class (1,290 output tokens × $30/M output tokens).
- **Aspect ratios:** 10 soportados, incluido 9:16 nativo (también 21:9, 16:9, 4:3, 3:2, 1:1, 3:4, 2:3, 5:4, 4:5).
- **Cuotas (Gemini API paid Tier 1, instant después de habilitar Cloud Billing):**
  - 10 IPM para modelos Imagen-family.
  - Para Nano Banana, ~500 RPD en Tier 1.
  - Tier 2 (20 IPM): $250 cumulative spend + 30 días.
  - Tier 3 (60+ IPM): más spend.

**Crítico:** la Gemini Developer API (`generativelanguage.googleapis.com`) y Vertex AI (`aiplatform.googleapis.com`) mantienen **pools de cuota separados incluso para el mismo nombre de modelo**. Esto es la palanca — se puede dual-key el mismo modelo a través de dos buckets de rate-limit independientes.

### D. Existen modelos Gemini 3 image más nuevos

- **`gemini-3.1-flash-image-preview`** ("Nano Banana 2"): $0.045 (0.5K) → $0.067 (1K) → $0.101 (2K) → $0.15 (4K) por imagen; agrega un imageSize ladder. Actualmente #3 en el Artificial Analysis Text-to-Image leaderboard (Elo 1264) al 23 mayo 2026.
- **`gemini-3-pro-image-preview`** ("Nano Banana Pro"): $0.134 a 1K/2K, $0.24 a 4K; mejor text rendering y prompt adherence (Elo 1220, #4). **Usar solo para hero scenes — demasiado caro como workhorse default.**

**Worth knowing:** per el live Artificial Analysis Text-to-Image leaderboard (artificialanalysis.ai, checked 23 mayo 2026), el top 5 actual es:

| Rank | Modelo | Elo |
|---|---|---|
| 1 | GPT Image 2 (high) | 1339 |
| 2 | GPT Image 1.5 (high) | 1266 |
| 3 | Nano Banana 2 | 1264 |
| 4 | Nano Banana Pro | 1220 |
| 5 | MAI-Image-2 | 1197 |

El ranking de Recraft V3 #1 de octubre 2024 ya no aplica; usar Recraft por su feature de style-control, no por raw quality leadership.

### E. Librerías de cascada

- **Cockatiel** (`connor4312/cockatiel`, el port de Polly para Node/TS): retry + circuit-breaker + bulkhead + timeout + fallback policies, todas componibles via `wrap()`. Esta es la unanimous community pick para resilience patterns en TypeScript.
- **Bottleneck** para per-provider RPM/IPM throttling (reservoir + minTime + maxConcurrent).
- **p-queue** si querés una per-provider priority queue más simple sin reservoir semantics.

### F. Los proyectos AI-Studio-auto-created tienen un bug conocido de billing-sync

Los proyectos `gen-lang-client-*` (auto-created by Google AI Studio) frecuentemente **se quedan atascados en el free-tier 0 IPM limit incluso después de linkear Cloud Billing**, con el quota editor rechazando valores (*"Enter a new quota value between 0 and 0"*). Múltiples Google Developer Forum threads lo confirman.

**Recomendación:** crear un fresh GCP project manualmente, linkear billing, después filear Imagen QIRs contra él. Quota-increase approval típicamente "within a few business days" per Google Cloud staff replies en el developer forum.

### G. Vercel AI Gateway es una reference architecture credible

Para TypeScript, el Vercel AI Gateway **ya implementa el patrón exacto que necesitás**:
- `providerOptions.gateway.models` declara un fallback model array.
- `order` declara provider preference per model.
- La response metadata incluye `modelAttempts[]` con per-attempt status, error, statusCode, responseTimeMs.

Usar como reference architecture aunque mantengas direct provider keys per tu constraint.

---

## Details

### 1. Recommended provider ordering y routing logic

Rutear por **estilo de preset primero**, después por cost tier:

| Preset / content type | Primary | Secondary | Tertiary |
|---|---|---|---|
| Photoreal (D2C product, lifestyle) | Nano Banana (Gemini API) | BFL Flux 2 Pro (direct) | fal.ai Flux 2 Pro |
| Illustration / cartoon | Recraft V3 (digital_illustration) | Nano Banana | Ideogram V3 |
| Comic / stylized | Nano Banana | Ideogram V3 | Recraft V3 (vector_illustration) |
| Text-heavy poster scene | Ideogram V3 | Gemini 3 Pro Image | Recraft V3 |
| Medical / pediatric / health brand | Nano Banana | Flux 2 Pro (BFL direct) | fal.ai Flux Dev — **NEVER gpt-image-1 aquí** |
| Emergency | Recraft V3 (realistic) | fal.ai Flux Dev | Nano Banana |

**Por qué estas picks sobre alternatives:**

- **Nano Banana over Imagen 4 Fast as primary:** Imagen 4 muere 24 jun 2026; Nano Banana tiene pool de cuota independiente de Vertex (podés quedarte en Gemini API mientras Vertex Imagen está en legacy quota); per-image cost es ~2× Imagen Fast ($0.039 vs $0.02) pero elimina la cascada de 429 a la que estás perdiendo plata hoy. Nano Banana también soporta `aspect_ratio` 9:16 nativo — sin upscale/crop.

- **BFL Flux 2 Pro direct over fal.ai as secondary:** la propia API de BFL (`api.us1.bfl.ai/v1/flux-pro-1.1`) te da el endpoint Flux de menor latencia, distinto del pricing resold de fal.ai. Usar fal.ai como tertiary porque agrega infraestructura independiente — per fal's own "10 Best AI Video Generators in 2026" page: *"Cold starts land between 5 and 10 seconds on fal, compared to 20 to 60 seconds (or more) on alternatives."* fal también se describe (Business Wire, 19 mayo 2026) como *"the world's largest generative media platform"* sirviendo 2.5 millones de developers, y reporta que actualmente powers 40% de los official image/video generation bots de Poe.

- **Recraft over Replicate:** Recraft V3 ships un true style parameter (`realistic_image`, `digital_illustration`, `vector_illustration`, `icon`) que mapea limpio a tu preset taxonomy. Replicate es un generic compute marketplace — fal es más rápido.

- **gpt-image-1 demoted, not removed:** es strong en text rendering y brand colors pero es el most aggressive content filter del field (ha rechazado escenas de niños + perros en playa en producción, per Microsoft Q&A reports). Mantenerlo para non-sensitive product hero shots donde text rendering importa. **Nunca poner adelante de Nano Banana en un preset medical/pediatric.**

- **Drop Higgsfield Flux Pro Kontext Max from primary chain** — Flux Pro Kontext es best-in-class para EDITAR una imagen de referencia pero es overkill y más lento que Nano Banana/Flux 2 para fresh scene generation. Mantener la key solo para el edit/upscale stage.

### 2. Adding Gemini Image — concrete specifics

- **Model ID:** `gemini-2.5-flash-image` (production GA name; el `-preview` alias fue apagado 15 ene 2026 — no usarlo).
- **Endpoint (Gemini Developer API, recommended):**
  ```
  POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent
  ```
- **Header:** `x-goog-api-key: $GOOGLE_AI_API_KEY`

**Example request body para 9:16 portrait:**

```json
{
  "contents": [
    { "parts": [{ "text": "<your scene prompt>" }] }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "aspectRatio": "9:16" }
  }
}
```

**Response decoding:** leer `candidates[0].content.parts[i].inlineData.data` (base64 PNG) → `Buffer.from(data, 'base64')` → wrap en tu existing `ImageProvider.generate()` return shape. Strip `inlineData.mimeType` para elegir extensión.

**Caveats que los docs de Google marcan:**

- **Field name shift entre SDK versions:** 2.5 Flash Image usa `imageConfig.aspectRatio`; la Gemini 3 family usa `responseFormat.image.aspectRatio` (y agrega `imageSize: "1K"|"2K"|"4K"`). Wrap both shapes en un small per-model adapter dentro de tu provider class.
- **Todos los outputs de Nano Banana incluyen un invisible SynthID watermark.** Eso está bien para marketing video frames.
- **Default behavior cuando aspectRatio es omitted** en image-editing es keep the source aspect ratio; en text-to-image defaultea a 1:1. **Siempre setear `aspectRatio` explícitamente a `"9:16"` para Video Factory** para evitar el silent 1:1 fallback que mordió a otros developers.
- **Tier 1 paid quota es 10 IPM.** El pipeline dispara ~22 requests en paralelo — even Nano Banana te va a 429ear. Throttlear a ≤10 IPM (uno cada 6s) vía Bottleneck, o upgradear a Tier 2 (20 IPM, requires $250 cumulative GCP spend + 30 días).

**Independence de cuota vs Vertex Imagen:** SÍ — la Gemini Developer API (`generativelanguage.googleapis.com`) tiene un pool de cuota totalmente separado de Vertex AI (`aiplatform.googleapis.com`). Podés correr Nano Banana via Gemini API como primary **Y** mantener Vertex Imagen como fallback path; sus 429s son independientes. **Esta es la single best architectural win disponible hoy.**

### 3. Fixing the cascade behavior

El bug pattern en tu código actual es conflating dos concerns separados:
1. **intra-provider retry** (transient 5xx, network blips, rate-limit con `Retry-After`)
2. **inter-provider failover** (provider down, quota exhausted para entire window, content-policy reject)

Necesitan policies distintas.

**Pseudocode pattern:**

```ts
import { retry, circuitBreaker, handleWhen, wrap, ConsecutiveBreaker, ExponentialBackoff } from "cockatiel";
import Bottleneck from "bottleneck";

// One throttler per provider, sized to that provider's safe RPM/IPM
const limiters = {
  gemini:  new Bottleneck({ reservoir: 10, reservoirRefreshAmount: 10, reservoirRefreshInterval: 60_000 }),
  bfl:     new Bottleneck({ maxConcurrent: 6, minTime: 200 }),
  fal:     new Bottleneck({ maxConcurrent: 8, minTime: 150 }),
  recraft: new Bottleneck({ maxConcurrent: 4, minTime: 500 }),
  openai:  new Bottleneck({ maxConcurrent: 3, minTime: 1_000 }),
  vertex:  new Bottleneck({ reservoir: 5,  reservoirRefreshAmount: 5,  reservoirRefreshInterval: 60_000 }),
};

// One circuit breaker per provider — opens for 60s after 3 consecutive non-content failures
const breakers = Object.fromEntries(Object.keys(limiters).map(k => [k,
  circuitBreaker(
    handleWhen(e => (e as ImageProviderError).isTransient || (e as ImageProviderError).isDailyQuotaExhausted),
    { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(3) }
  )
]));

// Intra-provider retry: only for transient errors (NOT content rejection, NOT quota)
const intraRetry = retry(
  handleWhen(e => (e as ImageProviderError).isTransient && !(e as ImageProviderError).isDailyQuotaExhausted),
  { maxAttempts: 3, backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 8_000 }) }
);

async function callProvider(p: ImageProvider, req: GenRequest) {
  return limiters[p.id].schedule(() =>
    wrap(intraRetry, breakers[p.id]).execute(() => p.generate(req))
  );
}

async function cascade(req: GenRequest, chain: ImageProvider[]) {
  const failures: Array<{provider: string, reason: string}> = [];
  for (const p of chain) {
    try {
      const img = await callProvider(p, req);
      return { img, provider: p.id, failures };
    } catch (e) {
      const err = e as ImageProviderError;
      failures.push({ provider: p.id, reason: err.kind /* 'quota'|'content'|'transient'|'auth' */ });
      // Skip to next provider IMMEDIATELY on quota-exhausted, circuit-open, or content-rejection
      continue;
    }
  }
  throw new AllProvidersFailedError(failures); // triggers graceful degradation
}
```

**Las reglas decisivas:**

1. **`isContentRejection`** → skip to next provider INMEDIATAMENTE, never retry within. Un 400 de gpt-image-1 diciendo "policy violation" va a seguir diciendo eso.
2. **`isDailyQuotaExhausted` o `online_prediction_requests_per_base_model` 429** → abrir el circuit para ese provider por 60s **Y** skip to next. No quemar budget probing.
3. **Transient (5xx, network reset, generic 429 sin per-base-model metric)** → exponential backoff con jitter, up to 3 attempts.
4. **Auth (401/403)** → fail loudly, no retry, no cascade silently — esto debería pagear un operator (es config bug, no runtime fault).

**Error classifier responsibility:** ponerlo INSIDE cada `ImageProvider.generate()` así la cascada no necesita conocer provider-specific error shapes. Cada provider mapea a uno de: `{ kind: 'transient'|'quota'|'content'|'auth'|'unknown', retryable, isDailyQuotaExhausted, isContentRejection }`. Esto es tu existing interface — el bug es que nadie está leyendo el `kind` field en el cascade layer.

### 4. Throttling / rate-limit design

**Recomendación:** Bottleneck per-provider limiters keyed by provider ID, configurados según el documented RPM/IPM de cada provider, paired con Cockatiel circuit breakers.

**Por qué Bottleneck over p-queue/p-limit:** soporta un reservoir que refills on a schedule (matches Google's IPM token-bucket exactly), soporta `maxConcurrent` y `minTime` simultaneously, tiene clustered Redis support si después escalás horizontalmente workers, y expone `depleted` / `error` events para observability. p-queue es más simple pero le falta reservoir semantics; p-limit es concurrency-only.

**Settings concretos per-provider (starting points, tune from logs):**

| Provider | Settings |
|---|---|
| Gemini API (Nano Banana, Tier 1) | `reservoir 10/60s`, `maxConcurrent 4`, `minTime 6000ms` |
| Vertex Imagen (asumiendo 5-20 RPM default; treat 5 RPM worst case) | `reservoir 5/60s`, `maxConcurrent 2` |
| BFL direct | `maxConcurrent 6`, `minTime 200ms` (BFL es async polling, concurrency cap matters más que RPM) |
| fal.ai | `maxConcurrent 8`, `minTime 150ms` |
| Recraft | `maxConcurrent 4`, `minTime 500ms` |
| OpenAI gpt-image-1 | `maxConcurrent 3`, `minTime 1000ms` |

**Burst control en orchestration layer:** incluso con per-provider throttling, NO disparar todas las 22 scenes' `generate()` en `Promise.all`. Usar p-queue o un Bottleneck a nivel rip con `maxConcurrent 6-8` across all providers combined, para que cascades de un failed provider no dogpilen el secondary. **El pattern 22-parallel es la proximate cause de los current spike failures.**

### 5. Vertex / GCP quota strategy

**Order of operations:**

1. **HOY: Mover el primary off Vertex Imagen a Nano Banana via Gemini Developer API.** Usar tu existing `GOOGLE_AI_API_KEY`. Habilitar Cloud Billing en el AI Studio project para landear en Tier 1 (10 IPM) — instant. **Esto solo arregla ~80% del problema de reliability** porque el Gemini API quota pool es independiente del Vertex base-model quota que está 429-eando.

2. **Crear un fresh manually-created GCP project (NO reusar `gen-lang-client-0913919937`).** Los AI-Studio-auto-created projects tienen un documented paid-tier sync bug donde billing-linking no levanta el free-tier 0 limit, y el quota editor rechaza valores. Multiple Google Developer Forum threads lo confirman.

3. **En el nuevo proyecto, habilitar Vertex AI API y filear un Quota Increase Request** para `aiplatform.googleapis.com/online_prediction_requests_per_base_model` para `imagen-4.0-fast-generate`, `imagen-4.0-generate`, e `imagen-4.0-ultra-generate` en `us-central1`. Pedir **60 RPM per base model**, justificando con "production batch image generation for short-form video; 22 scenes per rip × N rips/day." Aprobación típicamente "within a few business days" per Google Cloud staff replies en el developer forum. **NO pedir 500+** — large jumps get denied; ask for ~5-10× tu necesidad.

4. **Agregar una second region como quota fan-out:** `europe-west2` o `us-east4`. Vertex Imagen quotas son per-region. Si inicializás un Vertex client per region y round-robineás scene requests, **doblás tu effective RPM con cero extra approval cost**.

5. **Imagen 4 es end-of-life 24 jun 2026.** Whatever quota you get is a 30-day bandage. No invertir más que eso. El migration target es Nano Banana, y Vertex se usa best only como tertiary failover from June onward.

**On Provisioned Throughput (PT):** PT reserva capacity a un fixed monthly cost via GSU (Generative AI Scale Unit). Es overkill para tu volume (under 50,000 images/month) — DSQ + Nano Banana es sufficient. Revisit only si escalás past ~100k images/month.

### 6. Safety / content policy strategy

**Empirical permissiveness ranking** for legitimate-but-sensitive cases (medical, children's products, anatomy en product context), peor a mejor para producción:

1. **gpt-image-1 (OpenAI)** — most aggressive. Microsoft Q&A threads documentan false-positive blocks en escenas "child + puppy on beach". Scanea both prompt AND output y silenciosamente falla el entire call. **Nunca poner adelante de otros en health/pediatric presets.**

2. **Imagen 4 / Nano Banana (Google)** — strict on anatomical terms (block isolated "skin", "body parts"), pero generally pass educational/medical-illustration framings. Default-safe para D2C consumer products incluyendo baby goods, mientras los prompts usen parental/branded language ("baby teether held by parent", not "child's mouth").

3. **Flux 2 Pro (BFL)** — most permissive of major commercial APIs para legitimate content. `safety_tolerance: 2` es el production-balanced setting. Strong en real-people-ish scenes que gpt-image-1 va a rechazar.

4. **fal.ai-hosted open models (Flux Dev, SDXL, Wan)** — most permissive overall; appropriate como fallback only porque son también los lowest brand-control. Usar sparingly para el "all primaries failed, render anything legitimate" emergency lane.

**Prompt-engineering pattern (no jailbreaks, just disambiguation):**

- Reemplazar clinical anatomy terms con brand/role language: *"doctor expert" → "smiling healthcare professional in white coat reviewing product label"; "pediatric" → "for parents and small children, family-friendly setting."*
- Siempre incluir explicit non-violation phrases cuando context es borderline: *"wholesome family photography, soft daylight, professional advertising style."*
- Usar structured prompts (subject + action + context + style) — BFL's prompting guide explicitly recomienda esto y disallows negative prompts; **never write "no violence" porque el filter ve la palabra**.
- Pre-flight prompts through a quick policy classifier (one Gemini Flash call, ~$0.0001) en flagged presets (medical, children, health) y rewrite si el classifier scorea >0.7 risk.

### 7. Animation stage (Kling → Veo)

Sos open to replacing Kling/Veo. Keep both, swap el primary:

- **Primary:** Kling 2.5 Turbo Pro via fal.ai (`fal-ai/kling-video/v2.5/turbo/pro/image-to-video`), $0.07/sec → ~$0.35 por 5-sec clip. Mejor motion fluidity en el mid-tier y te deja reusar tu fal.ai key.
- **Secondary:** Veo 3.1 Fast. Per fal.ai's Veo 3.1 Fast model page: *"For every second of video you generate you will be charged $0.10 without audio or $0.15 with audio for 720p or 1080p."* Usar el $0.10/sec (no-audio) tier porque ElevenLabs ya está producing tu TTS.
- **Drop Kling direct** si no estás usando sus multi-shot o native-audio features — el resold endpoint de fal.ai es más barato y comparte tu existing key infrastructure.
- **Avoid Veo 3.1 Standard with audio ($0.40/sec)** — pay only para visuals.

A 22 scenes × 5 sec × $0.07/sec = **$7.70/rip en animation IF animás every scene**. Recomienda animar only ~30% de scenes (los hooks y transitions); usar Remotion's `Img` + Ken Burns transform for the rest. Keeps animation cost ~$2-3/rip y total rip cost under $5.

### 8. Graceful degradation cuando ALL providers fail

In order of preference:

1. **Try a relaxed-prompt regeneration** via tu cheapest available provider (rewrite prompt para remover anything que parezca policy trigger).
2. **Usar un brand-safe placeholder** — render the scene en Remotion con brand-color background + product overlay + el scene's text/subtitle. Acceptable para una B-roll scene y el rip still completes.
3. **Skip the scene entirely** si es un B-roll filler (metadata flag `optional: true`); el compositor extiende la preceding scene's duration para cover the audio.
4. **Pausar el rip** y emit an actionable diagnostic only si un hook scene (scene 0 o 1) falla fully — esos son visually critical.

**La regla:** el rip MUST complete unless un non-skippable hook scene cannot be rendered. Manual retries son forbidden by your "100% automatic" requirement.

### 9. Observability / diagnostics

**Minimum useful telemetry per rip:**

- Per scene: `{ scene_id, provider_used, attempts: [{ provider, status, latency_ms, error_kind?, error_message? }], elapsed_ms, fallback_depth }`.
- Per provider per rip: cumulative success, fail-by-kind (quota/content/transient/auth), p50/p95 latency, circuit-open events.
- Per rip: total cost (computed from provider × image-count × pricing table), wall-clock duration, degraded-scene count.

Storage as columns on el rip row en tu libsql/Drizzle DB; expose un `/api/rip/:id/diagnostics` route returning the JSON. El compositor stage embeds `provider_used` como un small overlay en dev mode for quick QA.

**Set up un single Slack/email webhook** que fire only cuando (a) un rip completes con >3 degraded scenes, o (b) un provider's circuit stayed open >5 minutes — both are operator-actionable.

Use OpenTelemetry only si ya tenés un collector. Otherwise simple structured `console.log` lines que Vercel/Fly logs ingest son sufficient a tu scale.

---

## Real Open-Source References

- **Vercel AI Gateway model-fallback docs** — canonical reference para el cascade-with-attempts-metadata pattern.
  https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks

- **Vercel AI SDK Image Generator template** (Next.js + AI SDK, multi-provider: Replicate, Vertex, OpenAI, Fireworks).
  https://vercel.com/templates/next.js/ai-sdk-image-generator

- **cockatiel** (TS resilience patterns — retry, circuit-breaker, bulkhead, fallback, wrap).
  https://github.com/connor4312/cockatiel

- **bottleneck** (per-provider RPM throttling con reservoirs).
  https://www.npmjs.com/package/bottleneck

- **`rushindrasinha/youtube-shorts-pipeline`** — Python equivalent de tu pipeline (script → AI visuals → TTS → Whisper captions → 9:16 render), con un explicit *"stock footage fallback when AI images fail"* pattern. Good architectural reference even though es Python.
  https://github.com/rushindrasinha/youtube-shorts-pipeline

- **`backblaze-b2-samples/image-generation-prompt-flow`** — Next.js 14 + Drizzle + multi-provider (OpenAI gpt-image-1 + Gemini Imagen) reference con SSE streaming de los cascade steps. **Casi tu exact stack.**
  https://github.com/backblaze-b2-samples/image-generation-prompt-flow

- **Remotion official org** — para el compositor stage, incluyendo los music-visualization y faceless-video templates.
  https://github.com/remotion-dev

- **fal.ai's `@fal-ai/client`** — drop-in replacement para any Flux/Kling/Wan call; same auth model across all 600+ image y video models, single billing.
  https://fal.ai/

- **Google AI for Developers image-generation reference** — source of truth para el Nano Banana / Gemini 3 image request body shape.
  https://ai.google.dev/gemini-api/docs/image-generation

- **Google's Dynamic Shared Quota doc** — confirma Imagen 4 NO está en DSQ (only Gemini family). Use this para push for QIR rather than wait for DSQ rollout.
  https://cloud.google.com/vertex-ai/generative-ai/docs/resources/dynamic-shared-quota

---

## Recommendations (staged)

### Stage 1 — This week (no quota waits needed)

1. Add `GeminiNanoBananaProvider` (new `ImageProvider` impl) que llame `gemini-2.5-flash-image` via Gemini Developer API con `imageConfig.aspectRatio: "9:16"`. Use existing `GOOGLE_AI_API_KEY`.
2. Hacerlo el first provider en la cascada para ALL presets.
3. Wrappear every provider call en cockatiel's retry × circuit-breaker policy plus un Bottleneck limiter — settings per §4.
4. Mover la cascade orchestration para classify errors via `kind` y skip to next provider en `kind === 'quota' | 'content'` sin retrying within.
5. Cap rip-level parallelism a 6-8 con un global Bottleneck.

### Stage 2 — Within 2 weeks (parallel a Stage 1)

6. Habilitar Cloud Billing en el Gemini API project; confirm Tier 1 (10 IPM) is active. Plan upgrade a Tier 2 (~$250 spend) within 30 days si rip volume lo requiere.
7. Crear un fresh manual GCP project (NOT `gen-lang-client-*`); habilitar Vertex AI API; filear un QIR para Imagen base-model RPM = 60 en `us-central1`. Expect approval en few business days.
8. Add `BFLFluxProvider` (direct `api.us1.bfl.ai`) como secondary para photoreal presets. Mover Higgsfield a "edit-only" (out of main chain).
9. Add `RecraftProvider` e `IdeogramProvider` para illustration/text-heavy presets.

### Stage 3 — Within 30 days (before 24 jun 2026)

10. Complete migration off Vertex Imagen entirely. Demote Vertex a single 4th-position fallback o remove.
11. Switch animation primary from Kling direct a Kling 2.5 Turbo Pro via fal.ai (`fal-ai/kling-video/v2.5/turbo/pro/image-to-video`). Mark Veo 3.1 Fast (no-audio, $0.10/sec) como fallback.
12. Implementar diagnostics endpoint + Slack alert webhook con el rip-summary JSON schema from §9.
13. Wirear una per-preset routing policy (la §1 table) en tu scene-planner output así cada scene carries `preferredProviderChain: string[]`.

### Benchmarks que cambiarían estas recommendations

- Si Imagen 4 EOL date slips past 24 jun 2026 (check Google's deprecations page weekly), keep Vertex Imagen como un real third-tier con un QIR'd quota.
- Si tu per-rip volume excede 100k images/month, evaluar Vertex Provisioned Throughput (GSU subscription).
- Si Nano Banana quality regresses en photoreal product shots en tu QA, promote BFL Flux 2 Pro a primary para photoreal presets y keep Nano Banana para illustration.
- Si content rejections exceed 5% en un specific preset, build un Gemini-Flash pre-flight prompt classifier en scene-planner que rewrite high-risk prompts antes de que peguen al image generator.
- Si un single provider's circuit opens >10× per day, that's un config o pricing issue — re-tune su Bottleneck reservoir down by 30%.

---

## Caveats

- Several quota numbers above son sourced from secondary aggregator blogs y Google Developer Forum reports donde Google no publica un definitive number. Treat any non-Google-doc number como "best community estimate" y verificar en el GCP Console quota editor para tu actual project antes de sizing limiters. En particular, el "default 5-20 RPM" para new-project Imagen 4 es from community forum reports, not an official Google number.

- Gemini API response shape differs entre `gemini-2.5-flash-image` (uses `imageConfig`) y `gemini-3.1-flash-image-preview` / `gemini-3-pro-image-preview` (use `responseFormat.image` con both `aspectRatio` y `imageSize`). Si decidís add Gemini 3 image models later, el adapter dentro de `GeminiImageProvider` necesita un per-model branch.

- El 24 jun 2026 Imagen shutdown está announced en Google's deprecations page; Google has been known to extend such dates. Don't bet on the deadline, but plan as if it's firm.

- BFL "Flux 2" y "Flux Pro 1.1" both exist; confirm el exact endpoint y pricing en bfl.ai/pricing at integration time — pricing ha estado changing every few months.

- Artificial Analysis leaderboard positions change frequently; el current top-5 ordering (GPT Image 2 high, GPT Image 1.5 high, Nano Banana 2, Nano Banana Pro, MAI-Image-2) es la 23 mayo 2026 snapshot — re-check antes de any quality-driven reordering.

- Vercel AI Gateway es un viable alternative architecture si querés outsource la cascada. We recommend keeping direct keys per tu constraint, pero el gateway es un valid Plan B si te encontrás rebuilding too much resilience logic.

- All recommendations assume tu pipeline runs en un long-lived Node/Vercel function (not un short-lived edge worker). Circuit breakers y Bottleneck reservoirs need shared in-memory state per worker; si escalás a multiple worker instances, switch Bottleneck a su Redis-backed clustering mode.
