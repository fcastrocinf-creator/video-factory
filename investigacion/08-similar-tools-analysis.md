# 08 — Análisis de herramientas similares (open-source y referencias)

> Estudio comparativo de proyectos públicos con arquitectura similar a Video Factory. Cada uno hace algo bien que vale la pena adoptar o adaptar. URLs y findings vienen de WebFetches y WebSearches realizadas en esta investigación.

## Resumen — qué adoptar de cada uno

| Proyecto | Lenguaje | Cosa más valiosa a "robar" |
|---|---|---|
| **OpenMontage** (`calesthio/OpenMontage`) | Python (89%) + TS Remotion | **Scored provider selection (7 dimensiones)**, pipeline manifests in YAML, post-render self-review |
| **youtube-shorts-pipeline** (`rushindrasinha/youtube-shorts-pipeline`) | Python 100% | **Resume capability (`state.py`)** + **fallback frames** cuando image-gen falla en vez de errorar |
| **Vercel AI Gateway** | TS (Vercel SDK) | **Declarative model fallback array** + **`modelAttempts[]` metadata** en la response |
| **backblaze image-generation-prompt-flow** | TS (Next.js + Drizzle) | **SSE streaming de cascade steps al UI** (visibilidad en tiempo real) |
| **ViMax** (`HKUDS/ViMax`) | Python (agentic) | **Roles agénticos** (Director, Screenwriter, Producer, Generator) por etapa |
| **AI UGC Generator** | Next.js | Reuso del stack — Stripe + MUAPI patterns |
| **claude-video-kit** (`runesleo/claude-video-kit`) | TS | Pipeline TS + Remotion focused, JSON-driven |

## 1. OpenMontage — el agentic monster

**URL:** https://github.com/calesthio/OpenMontage

Architecture: **agentic** — operado a través de AI coding assistants (Claude Code, Cursor, Copilot, Codex, Windsurf). 12 pipelines × 52 herramientas × 500+ skills.

### Lo más interesante para nosotros

**Scored Provider Selection (7 dimensiones):**
> *"7-dimension scoring engine: task fit (30%), output quality (20%), control features (15%), reliability (15%), cost efficiency (10%), latency (5%), continuity (5%)"*

OpenMontage rankea cada proveedor disponible para cada task contra alternatives, y loguea la decisión. Si el preferred provider falla o exhausta quota, el selector pivota al next-ranked option.

**Aplicación a Video Factory:** en vez de un chain hardcoded por preset (lo que propone Claude), podríamos tener un **selector dinámico** que score cada provider para cada escena según preset style + history. Más sofisticado pero más complejo. Para MVP, el chain estático es suficiente; el scoring es mejora futura.

### Costos referenciados

| Ejemplo | Costo | Notas |
|---|---|---|
| "The Last Banana" (60s) | $1.33 | Kling v3 + TTS + Suno music |
| "VOID — Neural Interface" (30s) | $0.69 | GPT-4 image + TTS + auto music |
| "Candyland" Ghibli-style | $0.15 | 12 FLUX images, **no video gen** |
| "Mori no Seishin" anime | $0.15 | 12 FLUX images + parallax |

**Lección directa:** animación de cada escena con Veo/Kling sube significativamente el costo. Para muchos casos, **FLUX images + Ken Burns en Remotion** da MEJOR ratio costo/calidad ($0.15 vs $1.33). Esto refuerza la recomendación de Claude (`EXT-claude-research.md §7`) de animar solo ~30% de las escenas.

### Pipelines explícitos

12 pipelines: Animated Explainer, Animation, Avatar Spokesperson, Cinematic, Clip Factory, Documentary Montage, Hybrid, Localization & Dub, Podcast Repurpose, Screen Demo, Talking Head + (1 unlisted). Cada uno sigue: `research → proposal → script → scene_plan → assets → edit → compose`.

**Aplicación:** Video Factory tiene esencialmente UN pipeline (rip + variant original). Pensar en pipelines diferenciados por intent (rip-fiel, original-broll, explainer, talking-head, etc.) es mejora futura — separa responsabilidades y permite optimizar por tipo.

### Lo que NO hace bien

> *"No hay specific mention of: rate-limit backoff strategies, quota exhaustion recovery paths, cascading fallback chains for quota exhaustion."*

OpenMontage **falla exactamente en lo que Video Factory está resolviendo**. Confirma que no hay un patrón canónico open-source para cascada robusta multi-provider — todos están medio improvisando.

## 2. youtube-shorts-pipeline — el minimalista que funciona

**URL:** https://github.com/rushindrasinha/youtube-shorts-pipeline

**Stack:** Python 100%, ffmpeg para render.
**Pipeline:** `Research → Script → Visuals → Voice → Captions → Assemble → Upload`.
**Costo declarado:** **~$0.11 por video**.

### Lo más interesante

#### Resume capability (`state.py`)

> *"state.py — Resume capability (resumable stages across all pipeline steps)"*

Si la pipeline falla en stage N, se puede reanudar desde stage N en vez de re-empezar. Ahorra tiempo y costo.

**Aplicación a Video Factory:** hoy un rip que falla a mitad pierde todo el progreso (script, voz, subtítulos ya generados). Implementar **resume-from-stage** sería un gran win — el `pipeline.ts` ya tiene `currentStep` en la DB; podría leer-y-reanudar.

#### Fallback frames cuando image generation falla

> *"If image generation fails, the pipeline uses simple fallback frames so assembly can still complete."*

Mismo principio que Claude recomienda (`EXT-claude-research.md §8 Graceful degradation`). Implementación trivial: si todos los providers fallan en una escena, renderizar background-color + texto de subtítulo en Remotion, y seguir.

#### Multi-provider LLM para script

Claude (primary), Gemini, GPT-4, Ollama local — multi-provider no es solo para imágenes, también para LLM.

**Aplicación:** Video Factory hoy usa Gemini para scene-planner; podríamos pensar fallback chain ahí también (Claude → GPT-4 → Gemini).

#### Tech: Ken Burns para imágenes estáticas

Usa ffmpeg con **Ken Burns zoom/pan** para dar movimiento a imágenes estáticas. **No usa AI video generation.** Costo total ~$0.11 vs nuestro ~$5-10.

**Aplicación:** ya alineado con `EXT-claude-research.md §7` — animar solo ~30% de escenas (hooks), Ken Burns para el resto. Reduce animation cost de ~$7/rip a ~$2-3.

## 3. Vercel AI Gateway — el patrón canónico de cascada declarativa

**URL:** https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks

### Cascada declarativa

```ts
const result = streamText({
  model: 'openai/gpt-5.5',                               // primario
  providerOptions: {
    gateway: {
      models: ['anthropic/claude-opus-4.7',
               'google/gemini-3.1-pro-preview'],         // fallbacks
    },
  },
});
```

Cero código de cascada — solo declarás el array. El gateway:
1. Intenta el primary.
2. Si falla, intenta el primero del `models[]`.
3. Si falla, el siguiente.
4. La response viene del primero que succeed.

### `modelAttempts[]` en la response metadata

Cada attempt queda registrado con detalle:

```json
{
  "modelAttempts": [
    {
      "modelId": "vertex:gemini-3.1-pro-preview",
      "canonicalSlug": "google/gemini-3.1-pro-preview",
      "success": false,
      "providerAttemptCount": 2,
      "providerAttempts": [
        { "attemptNumber": 1, "provider": "vertex", "success": false,
          "responseTimeMs": 15679.64, "error": "Internal error.", "statusCode": 500 },
        { "attemptNumber": 2, "provider": "google", "success": false,
          "responseTimeMs": 284.30, "error": "Internal error.", "statusCode": 500 }
      ]
    },
    { "modelId": "anthropic:claude-opus-4-7", "success": true,
      "providerAttempts": [{ "attemptNumber": 1, "responseTimeMs": 4521.78,
        "statusCode": 200, "providerResponseId": "msg_01ABC..." }]
    }
  ]
}
```

**Aplicación a Video Factory:** este es EXACTAMENTE el shape de telemetry que Claude recomienda en su §9 y que falta hoy. **Vale copiar la estructura tal cual** — la `runs` table podría tener una columna JSON `imageGenAttempts` per escena con este shape.

### Combinación de `models` + `order`

`order` controla la preferencia de provider PARA CADA MODELO:

```ts
models: ['openai/gpt-5.4-nano', 'anthropic/claude-opus-4.7'],
order: ['azure', 'openai'],   // primero Azure, después OpenAI, para cada model
```

**Aplicación:** Video Factory podría combinar (a) chain de modelos (Nano Banana, Imagen, Flux Pro) con (b) order de provider (Gemini API, Vertex AI) para cada uno. Más expresivo que el chain plano actual — y conecta con el insight de Claude sobre Nano Banana dual-key (Gemini API + Vertex como pools independientes).

## 4. backblaze image-generation-prompt-flow — el más cercano a nuestro stack

**URL:** https://github.com/backblaze-b2-samples/image-generation-prompt-flow

**Stack:** Next.js 14 + Drizzle + TS — **casi idéntico al nuestro**.

**Patrón principal:** generación PARALELA (no failover) — dispara el mismo prompt a OpenAI gpt-image-1 + Gemini Nano Banana simultáneamente para comparar outputs.

### Lo más interesante

#### SSE streaming de cascade steps

> *"Server-Sent Events para streaming en tiempo real del progreso del pipeline."*

El UI muestra **el progreso del pipeline en vivo**: action plan → thinking → prompt construction → generation. Cada stage se reporta al cliente via SSE.

**Aplicación a Video Factory:** hoy el usuario ve un % de progreso plano. Implementar SSE/WebSocket para mostrar:
- "Generando escena 5/22…"
- "Provider Gemini OK (2.3s)"
- "Validating with Gemini Vision…"
- "Re-generando escena 5 con hint…"

Mejora dramática de UX, y el código del block ya tiene `onBlockProgress` (extender al detalle per-attempt).

#### Prompt-flow multi-stage

> *"Multi-stage LLM pipeline to optimize prompts: Action Plan, Thinking, Prompt Construction, Generation."*

Estructura del prompt: NO va el prompt raw del usuario al image generator. Va un prompt ELABORADO por un LLM que:
1. Hace un action plan (qué imagen necesito).
2. Razona sobre el subject/style/composition.
3. Construye el prompt visual.
4. Solo después llama al image generator.

**Aplicación:** Video Factory hace algo parecido con el `scene-planner` (genera `imagePrompt` por escena desde el script). Pero podríamos sumar una pasada extra de "refinement" antes del image-gen, especialmente para presets sensibles. Esto se conecta con el "pre-flight classifier" de `06-content-policy-strategies.md`.

## 5. ViMax (HKUDS) — el agentic con roles

**URL:** https://github.com/HKUDS/ViMax

**Patrón:** "Director, Screenwriter, Producer, and Video Generator All-in-One" — múltiples agents con roles definidos colaborando.

**Lección potencial:** en vez de un pipeline lineal, modelar las etapas como **agents con responsabilidades** que se pueden re-ejecutar/iterar:
- **Screenwriter agent**: genera/refina el script.
- **Director agent**: planifica las escenas, decide estilos.
- **Producer agent**: ejecuta y supervisa, decide qué proveedor usar.
- **Video Generator agent**: ejecuta el render.

Más overhead pero más debuggeable y modular.

**Aplicación a Video Factory:** **mejora futura, no MVP.** Hoy el flujo lineal funciona; pasar a agents tiene un costo de complejidad alto. Pero el patrón es interesante si en el futuro queremos hacer el sistema más "auto-correctivo".

## 6. AI UGC Generator y claude-video-kit — confirmación del stack

- **AI UGC Generator** — Next.js + Veo 3.1 + Seedance 2 + Grok Video + Happy Horse, self-hosted con Stripe + MUAPI.
- **claude-video-kit** (`runesleo/claude-video-kit`) — TTS + Whisper + Remotion en TS, JSON-driven script.

Ambos confirman que el **Next.js + Remotion + TS** stack es estándar para esta categoría de tools. Video Factory está bien parado en stack — no hay nada que migrar por razones técnicas.

## Patrones consolidados a adoptar (síntesis)

### Inmediatos — alineados con `99-PLAN-FINAL.md`

1. **Cascada declarativa con error classification** (Vercel AI Gateway + Cockatiel patterns) — `99-PLAN-FINAL.md` Paso 1.
2. **`modelAttempts[]` metadata** en la response (Vercel pattern) — `99-PLAN-FINAL.md` Paso 4 (telemetría).
3. **Fallback frames + skip-scene cuando todo falla** (youtube-shorts pattern) — `EXT-claude-research.md` §8 graceful degradation.
4. **Throttling per-provider con Bottleneck** (universal) — `99-PLAN-FINAL.md` Paso 3.

### Mejoras de mediano plazo (post-MVP)

5. **SSE streaming del pipeline al UI** (backblaze pattern) — gran win de UX, código liviano. Extender el `onBlockProgress` existente.
6. **Resume-from-stage** (youtube-shorts `state.py` pattern) — `pipeline.ts` ya tiene `currentStep` en DB; falta la lógica de resume.
7. **Ken Burns para escenas sin animación** (youtube-shorts + Claude §7) — ya alineado, reduce costo de animation de ~$7/rip a ~$2-3.
8. **Pre-flight prompt classifier** para presets sensibles (Claude §6 + backblaze multi-stage prompt) — `06-content-policy-strategies.md`.

### Mejoras de largo plazo (futuras, complejas)

9. **Scored provider selection dinámico** (OpenMontage 7-dimension) — reemplazaría el chain estático con un selector que score cada provider para cada escena.
10. **Pipelines diferenciados por intent** (OpenMontage 12-pipelines) — separar el `rip` flow del `original` flow del `explainer` flow.
11. **Agentic decomposition con roles** (ViMax) — Director, Screenwriter, Producer, Generator como agents colaborando. Solo si la complejidad lo justifica.

## Conclusión: ningún proyecto open-source resuelve exactamente lo que Video Factory necesita

Esto es importante:

- **OpenMontage** tiene la complejidad pero no resuelve fallback robusto en cuotas.
- **youtube-shorts-pipeline** es minimalista y bueno, pero usa solo 1 provider por task.
- **backblaze** es el más cercano en stack pero hace **comparación paralela**, no cascada.
- **Vercel AI Gateway** tiene la cascada perfecta pero es **LLM-focused**, no image-gen.
- **ViMax** es agentic pero no foco en confiabilidad.

**Video Factory está en territorio relativamente único** en su combinación: multi-provider image-gen + cascada robusta + animación opcional + composición Remotion + ad-focused. **No es copy-paste de ningún OSS** — la solución va a ser propia.

El plan en `99-PLAN-FINAL.md` (con los updates de Claude en `EXT-claude-research.md`) consolida el approach correcto. Los proyectos open-source nos dan **piezas reutilizables (patrones, librerías, ideas)** pero no una solución llave-en-mano.

## Fuentes

- [calesthio/OpenMontage — GitHub](https://github.com/calesthio/OpenMontage)
- [rushindrasinha/youtube-shorts-pipeline — GitHub](https://github.com/rushindrasinha/youtube-shorts-pipeline)
- [Vercel AI Gateway — Model Fallbacks docs](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks)
- [backblaze-b2-samples/image-generation-prompt-flow — GitHub](https://github.com/backblaze-b2-samples/image-generation-prompt-flow)
- [HKUDS/ViMax — GitHub](https://github.com/HKUDS/ViMax)
- [runesleo/claude-video-kit — GitHub](https://github.com/runesleo/claude-video-kit)
- [anil-matcha/open-generative-ai — GitHub](https://github.com/anil-matcha/open-generative-ai)
- [RianNegreiros/AiShortsVideosGenerator — GitHub](https://github.com/RianNegreiros/AiShortsVideosGenerator)
