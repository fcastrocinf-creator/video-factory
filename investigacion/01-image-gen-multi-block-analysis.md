# 01 — Análisis del bloque `ImageGenMultiBlock` y la cascada actual

> **TL;DR:** la cascada DEL CHAIN sí está implementada (línea 217+ de `block.ts`), pero **falla en saltar al siguiente proveedor cuando un proveedor 429ea por RPM**. La razón: el `VertexImagenProvider` nunca marca un error como `isDailyQuotaExhausted=true` — y el chain solo salta de step cuando ese flag (o `isContentRejection`) está prendido. Los 429 de Vertex se interpretan como "transient retryable", se reintentan 5 veces con backoff (que igual fallan porque la cuota es por minuto y muy baja en el proyecto), y al agotarse los retries el error se propaga UP sin tocar Higgsfield, AI Studio Imagen ni fal.ai.

## Fuentes leídas

- `packages/blocks/image-gen-multi/src/block.ts` (líneas 244-353 — `callProviderWithApiRetry`)
- `packages/blocks/image-gen-imagen/src/vertex-provider.ts` (líneas 142-156 — manejo de error)
- `packages/blocks/image-gen-imagen/src/openai-provider.ts` (líneas 127-150 — manejo de error)
- `packages/blocks/image-gen-imagen/src/provider.ts` (interface `ImageProvider` + `ImageProviderError` con flags)
- `apps/web/lib/pipeline.ts` (líneas 323-389 — construcción del chain)

## El chain construido en `pipeline.ts`

Orden documentado del provider chain (`pipeline.ts:326-330` + bloques siguientes):

```
1.   OpenAI gpt-image-1 (primario)              ← if (openaiApiKey)
2-4. Vertex Imagen 4 fast / std / ultra         ← if (gcpProjectId && gcpCredentials)
5-7. AI Studio Imagen 4 fast / std / ultra      ← if (googleApiKey)
8.   Higgsfield Flux Pro Kontext Max            ← if (higgsfieldKeyId && higgsfieldKeySecret)
9-10. fal.ai Flux Pro v1.1 / Flux Dev            ← if (falApiKey)
```

Con el `.env` actual del usuario, los 10 steps están armados.

## `callProviderWithApiRetry` — la lógica del chain (pseudocódigo)

(Lo realmente importante, simplificado de `block.ts:244-353`)

```ts
while (true) {
  const step = pickNextAvailableStep();          // primer step NO marcado exhausted
  if (!step) throw lastErr;                      // todos exhaustos → game over

  let stepExhausted = false;
  for (let i = 0; i <= MAX_API_RETRIES; i++) {   // MAX_API_RETRIES = 5
    await acquireSlot();                         // throttle global MIN_INTERVAL_MS = 6500ms
    try {
      return await step.provider.generate(...);  // ÉXITO → return
    } catch (e) {
      if (e.isDailyQuotaExhausted) {
        exhaustedSteps.add(stepIdx);             // marca step como muerto
        stepExhausted = true;
        break;                                   // sale del for → while → próximo step
      }
      if (e.isContentRejection && otherAvailable) {
        exhaustedSteps.add(stepIdx);             // contenido tóxico para este modelo
        stepExhausted = true;
        break;                                   // próximo step
      }
      if (e.isContentRejection && !otherAvailable) throw e;  // sanitize en outer loop
      if (!retryable || i === MAX_API_RETRIES) throw e;      // ⚠️ AQUÍ MUERE LA CASCADA
      // backoff exponencial + retry mismo step
    }
  }
  if (!stepExhausted) throw lastErr;             // (defensivo)
}
```

**Punto crítico:** la única forma de pasar de un step al siguiente es:
- `e.isDailyQuotaExhausted === true`, o
- `e.isContentRejection === true` con otros disponibles.

Si un error retryable no se resuelve en 5 retries, **se propaga hacia arriba, NO al siguiente step**. La línea 330 (`throw e`) es la trampa.

## Qué hace `VertexImagenProvider` en un 429

(`vertex-provider.ts:142-156`)

```ts
if (!resp.ok) {
  const bodyText = await resp.text();
  // Vertex 429 puede ser RPM (per-minute) o quota request — pero NO tiene daily caps
  // como AI Studio, así que isDailyQuotaExhausted siempre false: el retry-with-backoff
  // del image-gen-multi se encarga.
  const retryable = resp.status === 429 || resp.status >= 500;
  throw new ImageProviderError(
    `Vertex Imagen ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
    resp.status,
    bodyText,
    retryable,
    false,                       // ← isDailyQuotaExhausted SIEMPRE false
    this.name,
  );
}
```

El comentario reconoce que el 429 puede ser RPM o "quota request", pero los trata igual. Sin el flag de quota-exhausted, el chain ataca al mismo provider con backoff hasta agotar `MAX_API_RETRIES`. Como la cuota `online_prediction_requests_per_base_model` es del orden de 5 RPM por default en este proyecto, el backoff de 4-60s no cubre lo suficiente: cada retry vuelve a chocar con la misma cuota.

## El flujo real del rip que falló (reconstruido)

1. Scene 0: OpenAI gpt-image-1 → **content rejection** (probable, por contenido pediátrico/médico — gpt-image-1 lo marca como 400 con keyword "safety", el provider devuelve `isContentRejection=true`) → step marcado exhaust → próximo step.
2. Scene 0: Vertex Imagen 4 fast → **429** (`online_prediction_requests_per_base_model`) → `isDailyQuotaExhausted=false`, `retryable=true` → backoff (4s, 8s, 16s, 32s, 60s) y 5 retries.
3. Tras 5 retries, todos 429 (la cuota es por minuto, muy baja; las 22 escenas en paralelo la saturan permanentemente) → throw.
4. `generateAndValidate` propaga → `Promise.all(workers)` rechaza → catch principal del block (`block.ts:645-653`) → `BlockError("API_429")` → run failed.
5. **Vertex Imagen 4 std, ultra, AI Studio fast/std/ultra, Higgsfield Flux Pro, fal.ai Flux Pro/Dev — NUNCA fueron probados.**

Coincide exactamente con el mensaje reportado al usuario: `Error generando imágenes (multi): Vertex Imagen 429 Too Many Requests`.

## Los bugs identificados

### Bug 1 — `VertexImagenProvider` no detecta el 429 "real quota"

El 429 con `Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model` es **funcionalmente** un quota-exhausted issue para nuestro caso: la cuota es tan baja en el proyecto `gen-lang-client-*` que retry con backoff no resuelve nada — solo demora el inevitable fallo y burnea minutos del rip.

**Fix sugerido:** parsear el body del 429 y, si contiene `online_prediction_requests_per_base_model` (o un patrón más amplio: `Quota exceeded.*base_model`), marcar `isDailyQuotaExhausted=true` para que el chain salte al próximo provider en el primer intento (no después de 5 retries inútiles).

```ts
// pseudocode del fix en vertex-provider.ts
const isQuotaExhausted =
  resp.status === 429 &&
  /quota.*exceeded|RESOURCE_EXHAUSTED|online_prediction_requests_per_base_model/i.test(bodyText);
throw new ImageProviderError(
  `Vertex Imagen ${resp.status}...`,
  resp.status,
  bodyText,
  retryable && !isQuotaExhausted,
  isQuotaExhausted,            // ← NUEVO
  this.name,
);
```

### Bug 2 — El chain no convierte "5 retries exhaustos" en "step exhausto"

Cuando `MAX_API_RETRIES` se agotan en un error retryable, el código throwea en vez de tratar ese step como exhausto y probar el próximo. Esto contradice el espíritu del multi-provider chain.

**Fix sugerido (red de seguridad):** en el catch del último retry (`i === MAX_API_RETRIES`), en vez de `throw e`, hacer:

```ts
if (i === MAX_API_RETRIES) {
  ctx.logger.warn({ ..., step: stepLabel }, 'image-gen-multi:step_retries_exhausted_marking_dead');
  exhaustedSteps.add(stepIdx);
  stepExhausted = true;
  break;          // → próximo step en el while exterior
}
```

Ambos fixes son complementarios: Bug 1 evita gastar 5 retries cuando ya sabemos que va a fallar; Bug 2 es la red de seguridad por si otro provider tiene una clase de error que no detectamos como quota.

### Bug 3 — Quotas independientes pero saturadas en serie

`online_prediction_requests_per_base_model` es PER BASE MODEL: `imagen-4.0-fast-generate`, `imagen-4.0-generate`, `imagen-4.0-ultra-generate` tienen pools separados. Pero todos en el mismo proyecto `gen-lang-client-*` tienen el mismo default bajo. Si fast 429-exhausta, std muy probablemente 429 al primer request también.

**No es un bug del código** — es una propiedad de los proyectos de Google. Pero implica que la cascada saltará rápido por las 3 entradas Vertex sin éxito, llegando finalmente a AI Studio Imagen, Higgsfield, fal.ai. Eso está bien siempre que el Bug 1 esté arreglado (saltar rápido en vez de gastar 5 retries por step).

### Bug 4 — Logging insuficiente del cascading

El chain loguea cuando marca un step como exhausted (`image-gen-multi:provider_daily_quota_exhausted_switching`), pero **no loguea cuando agota retries de un step sin marcarlo como exhausted**. El usuario no ve que se está reintentando Vertex 5 veces. Una mejora simple: loguear cada retry con el provider+modelo+scene+attempt para visibilidad.

## Recomendaciones (orden de impacto)

1. **Implementar Bug 1 + Bug 2.** Sin esto, agregar Gemini Image o cualquier provider nuevo no soluciona nada — el primer 429 de Vertex sigue tumbando el rip. Es la pieza más importante de toda la investigación.
2. **Agregar `GeminiImageProvider`** (Nano Banana 2 — `gemini-3.1-flash-image-preview`) ANTES de Vertex Imagen en el chain. Cuota independiente, más permisivo con contenido sensible. (Ver `02-gemini-image-api.md`.)
3. **Throttling explícito por proveedor** (no solo el `acquireSlot` global). Cada provider tiene su propio rate limit que vale respetar — ver `04-resilience-patterns-ts.md` (pendiente).
4. **Logging del chain en cascada**: cuando un step se marca exhausted (o queda exhausto por Bug 2 fix), loguear cuál fue, por qué (quota / content / retry-exhausted) y a qué step pasa. Sirve para debugging futuro y para que el usuario entienda qué está pasando.

## Snippet relevante — `ImageProviderError`

(`provider.ts:29-45`)

Los flags clave:
- `retryable` — vale reintentar con el MISMO step.
- `isDailyQuotaExhausted` — saltar al próximo step de la chain.
- `isContentRejection` — el prompt es tóxico para este modelo; saltar de step si hay otros, o sanitizar prompt si no.

El helper `fromImagenError` (líneas 50-69) ya tiene heurísticas para detectar daily quota y content rejection desde la API legacy de AI Studio Imagen — pero el `VertexImagenProvider` NO la usa (construye `ImageProviderError` directo). Una alternativa al Bug 1 fix es ampliar `fromImagenError` para que también cubra el caso Vertex, y hacer que ambos providers la usen.
