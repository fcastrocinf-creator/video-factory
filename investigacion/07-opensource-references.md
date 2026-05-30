# 07 — Referencias open-source y artículos relacionados

> Proyectos públicos y posts técnicos relevantes encontrados durante la investigación. Ninguno es una solución llave-en-mano para nuestro caso (multi-provider image gen + cascada robusta + scene-planner + animation + composition), pero hay piezas útiles que vale tener mapeadas.

## Multi-provider image generation en TypeScript

### `backblaze-b2-samples/image-generation-prompt-flow`

URL: https://github.com/backblaze-b2-samples/image-generation-prompt-flow

**Qué hace:** app TS + Next.js que compara side-by-side OpenAI gpt-image-1, DALL-E, Gemini Nano Banana e Imagen.

**Patrón arquitectónico:** **generación PARALELA**, no failover — dispara el mismo prompt a múltiples providers a la vez para comparar outputs. Útil para nuestro debugging (queremos ver outputs de cada provider para el mismo prompt), pero **no sirve como modelo de cascada** porque no implementa failover.

**Lo aprovechable:**
- Estructura del prompt-flow multi-stage: *action plan → thinking → prompt construction → generation*. Encaja con nuestro `scene-planner` → `image-gen-multi`.
- Server-Sent Events para streaming de progreso al UI — aplicable a la mejora de telemetría del Paso 6 del plan final.

**Lo NO aprovechable:**
- No tiene fallback chain.
- No tiene retry/circuit-breaker.
- Solo dos providers.

### `elizaOS/eliza` (issue #1270)

URL: https://github.com/elizaOS/eliza/issues/1270

**Qué hace:** agent framework con fallback chain de image providers (Heurist, Together, FAL, OpenAI, Venice).

**Bug conocido (issue #1270):** si el `imageModelProvider` no matchea con `modelProvider`, el fallback puede usar la primera key disponible aunque sea del provider "equivocado".

**Lo aprovechable:** confirma que el patrón "chain" es común en otros proyectos de AI. **No es modelo a copiar** — más bien advertencia de los bugs típicos.

## Resilience patterns en TS para AI APIs

### Artículo: Circuit Breaker for LLM with Retry and Backoff — Anthropic API Example (TypeScript)

URL: https://medium.com/@spacholski99/circuit-breaker-for-llm-with-retry-and-backoff-anthropic-api-example-typescript-1f99a0a0cf87

**Qué cubre:** patrón circuit-breaker + retry + backoff aplicado a la API de Anthropic Claude en TS. El código y el approach son **transferibles 1:1 a multi-provider image-gen** — los problemas (rate limits, transient errors, cascada a fallbacks) son los mismos.

### Artículo: API Resilience — Circuit Breakers, Retries, Bulkheads 2026 (APIScout)

URL: https://apiscout.dev/blog/api-resilience-circuit-breakers-retries-bulkheads-2026

**Qué cubre:** panorama actualizado de los 4 patrones (retry, circuit breaker, bulkhead, timeout) en Node.js, con código. Buena referencia general.

### Artículo: Circuit Breaker & Retry Patterns in Node.js (2026) — 1xAPI

URL: https://1xapi.com/blog/resilient-api-circuit-breaker-bulkhead-retry-nodejs-2026

**Qué cubre:** mismo tema, otro ángulo. Útil para validar opciones de librerías.

## Quotas y errores de Vertex en la comunidad

### GitHub Issue — `cg-dot/vertexai-cf-workers#18`

URL: https://github.com/cg-dot/vertexai-cf-workers/issues/18

Reporte de OTRA persona con EL MISMO ERROR EXACTO que vimos:
> `Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model with base model: anthropic-claude-3-5-sonnet. RESOURCE_EXHAUSTED`

Validación de que es un patrón conocido, no específico a Imagen ni a nuestro proyecto.

### Google Dev Forum — Vertex AI veo-2.0-generate-001 quota 0

URL: https://discuss.google.dev/t/vertex-ai-veo-2-0-generate-001-quota-for-regional-online-prediction-requests-per-base-model-is-0/190466

Caso donde un base model de Vertex empieza con **cuota literalmente 0** por default. Reafirma que pedir aumento es operación normal, no excepción.

### Anuncio: Imagen 4 + Dynamic Shared Quota

URL: https://news.aibase.com/news/18207

Anuncio de la llegada de Imagen 4 a Vertex con **Dynamic Shared Quota**. Confirma que el comportamiento de "429 esporádico aunque estés bajo el cap nominal" es **by-design** del lado Google (no un bug de nuestro cliente).

## Lo que NO encontré (búsqueda pendiente, baja prioridad)

- Un proyecto open-source TS que combine multi-provider image gen + scene-planning + animation + composition (Remotion-like). Video Factory parece bastante singular en esa combinación específica.
- Benchmarks empíricos de content-policy comparando Gemini Image vs OpenAI gpt-image-1 vs Imagen 4 vs Flux — la mayoría de la información disponible es anecdótica.
- Reportes específicos del RPM real de `gemini-3.1-flash-image-preview` en paid tier — Google no lo publica.

## Para complementar con investigación externa

Cuando recibas las respuestas de Claude Deep Research y de ChatGPT con el brief que te entregué, vale anexar acá (o en `EXT-claude-research.md` / `EXT-chatgpt-research.md`):
- Otros proyectos open-source que esas IAs encuentren.
- Recomendaciones de librerías o patrones que yo no consideré.
- Cualquier benchmark empírico de content-policy.
- Patrones de prompt engineering para evitar safety filters legítimamente.
