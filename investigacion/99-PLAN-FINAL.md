# 99 — PLAN FINAL: arquitectura confiable de generación de imágenes

> Síntesis opinada de toda la investigación (docs 01-07 + WebFetches).
> Si tienes que leer un solo doc de esta carpeta, sea este.

## TL;DR — qué hacer y en qué orden

| # | Acción | Effort | Impacto |
|---|---|---|---|
| 1 | **Fix Bug 1 + Bug 2** en `VertexImagenProvider` y `ImageGenMultiBlock` | ~1 día | **El más alto.** Sin esto, agregar providers no salva nada. |
| 2 | **Agregar `GeminiImageProvider`** (Gemini 3.1 Flash Image Preview) | ~1 día | Alto. Cuota independiente, mejor calidad ilustrada, más permisivo. |
| 3 | **Throttling per-provider con Bottleneck** | ~0.5 día | Medio. Evita ser nosotros la causa del 429. |
| 4 | **Telemetría visible del chain** | ~0.5 día | Medio. Para debugging futuro y experiencia del usuario. |
| 5 | **Pedir aumento de cuota Vertex** | 10 min de form | Bajo (background). No bloquea nada. |
| 6 | **Ruteo del chain por estilo de preset** | ~1 día | Bajo, opcional. Mejora de calidad por escenario. |

**Total estimado: 3-4 días de implementación.**
**Resultado:** rip robusto que se completa sin intervención manual aunque OpenAI rechace contenido o Vertex 429.

## El problema en una frase

El sistema TIENE un chain multi-provider bien armado (`pipeline.ts:336-389`), pero la lógica de cascada en `ImageGenMultiBlock` SOLO salta de proveedor cuando el error está marcado como `isDailyQuotaExhausted=true` o `isContentRejection=true`. **El `VertexImagenProvider` NUNCA marca un 429 como quota-exhausted**, así que el chain se queda atascado reintentando Vertex 5 veces (mismo proyecto, misma cuota, mismo fallo) y muere sin tocar Higgsfield, AI Studio, ni fal.ai.

(Detalles en `01-image-gen-multi-block-analysis.md`.)

## Plan de implementación

### Paso 1 — Fix de la cascada (Bug 1 + Bug 2)

**Archivos a tocar:**
- `packages/blocks/image-gen-imagen/src/vertex-provider.ts`
- `packages/blocks/image-gen-multi/src/block.ts`

**Bug 1 — `VertexImagenProvider` debe detectar el 429 "real quota":**

```ts
// vertex-provider.ts, dentro del !resp.ok catch:
const isQuotaExhausted =
  resp.status === 429 &&
  /quota.*exceeded|RESOURCE_EXHAUSTED|online_prediction_requests_per_base_model/i.test(bodyText);

throw new ImageProviderError(
  `Vertex Imagen ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
  resp.status,
  bodyText,
  !isQuotaExhausted && (resp.status === 429 || resp.status >= 500),  // retryable solo si NO es quota
  isQuotaExhausted,                                                   // ← NUEVO
  this.name,
);
```

**Bug 2 — Block trata "5 retries exhaustos" como step exhausto:**

```ts
// block.ts, en el catch del último retry (donde hoy hace throw e):
if (i === MAX_API_RETRIES) {
  ctx.logger.warn(
    { runId: ctx.runId, scene: sceneIdx, step: stepLabel },
    'image-gen-multi:step_retries_exhausted_marking_dead',
  );
  exhaustedSteps.add(stepIdx);
  stepExhausted = true;
  break;  // sale del for → próximo step en el while exterior
}
```

**Test:** correr un rip con el preset doctor + bebé. Esperado: ahora cae a Gemini / Higgsfield al ver el primer 429 de Vertex, y termina exitosamente.

### Paso 2 — Agregar `GeminiImageProvider`

**Nuevo archivo:** `packages/blocks/image-gen-imagen/src/gemini-image-provider.ts` (~150 líneas siguiendo el patrón de `google-provider.ts` y `openai-provider.ts`).

**Modelo primario:** `gemini-3.1-flash-image-preview` ("Nano Banana 2").
**Modelo fallback dentro de Gemini:** `gemini-2.5-flash-image` ("Nano Banana", versión estable).

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
**Auth:** `x-goog-api-key: <GOOGLE_AI_API_KEY>` (key existente).

(Pseudocódigo completo en `02-gemini-image-api.md`.)

**Wire-up en `pipeline.ts:339-389`** — insertar **después de OpenAI** y **antes de Vertex Imagen**:

```ts
// (después del bloque que crea OpenAI provider)

if (googleApiKey) {
  const geminiImage = new GeminiImageProvider({ apiKey: googleApiKey });
  providerChain.push(
    { provider: geminiImage, model: 'gemini-3.1-flash-image-preview', label: 'gemini:flash-image-3.1' },
    { provider: geminiImage, model: 'gemini-2.5-flash-image',         label: 'gemini:flash-image-2.5' },
  );
}

// (luego se construye el resto del chain — Vertex Imagen, etc.)
```

**Tests críticos:**
- Smoke test con un prompt simple → confirmar que el body REST devuelve `inline_data.data` parseable.
- Verificar que aspect ratio 9:16 se respeta (puede requerir tunear la sintaxis del field).
- Verificar content policy con el prompt pediátrico que tumbó OpenAI — debería pasar.

### Paso 3 — Throttling per-provider con Bottleneck

**Archivos a tocar:** `packages/blocks/image-gen-multi/src/block.ts` (reemplazar `acquireSlot` global con limiters per-step).

```ts
import Bottleneck from 'bottleneck';

// En el constructor o init del block:
const limiters = new Map<string, Bottleneck>();
function getLimiter(providerName: string): Bottleneck {
  if (!limiters.has(providerName)) {
    limiters.set(providerName, makeLimiterFor(providerName));
  }
  return limiters.get(providerName)!;
}
function makeLimiterFor(providerName: string): Bottleneck {
  switch (providerName) {
    case 'vertex-imagen':    return new Bottleneck({ minTime: 1200, maxConcurrent: 2 });   // 50 RPM
    case 'openai-image':     return new Bottleneck({ minTime: 0,    maxConcurrent: 5 });
    case 'gemini-image':     return new Bottleneck({ minTime: 100,  maxConcurrent: 10 });
    case 'google-imagen':    return new Bottleneck({ minTime: 6000, maxConcurrent: 1 });   // AI Studio conservador
    case 'higgsfield-image': return new Bottleneck({ minTime: 200,  maxConcurrent: 5 });
    case 'fal-image':        return new Bottleneck({ minTime: 200,  maxConcurrent: 5 });
    default:                 return new Bottleneck({ minTime: 1000, maxConcurrent: 2 });
  }
}

// En vez de await acquireSlot() + step.provider.generate():
const buffer = await getLimiter(step.provider.name).schedule(() =>
  step.provider.generate({ prompt, aspectRatio: '9:16', model: step.model }),
);
```

**Dependencia:** `pnpm add bottleneck -F @video-factory/block-image-gen-multi`.

(Detalles + alternativas con Cockatiel en `04-resilience-patterns-ts.md`.)

### Paso 4 — Telemetría visible del chain

**Archivos a tocar:** `block.ts`, `apps/web/app/(app)/runs/[id]/RunViewer.tsx`.

En el block, agregar logs estructurados con consistency:
- `image-gen-multi:provider_attempt` — cada vez que un step inicia.
- `image-gen-multi:provider_success` — cada éxito, con timing.
- `image-gen-multi:provider_skipped` — cuando se marca exhausted (con motivo: quota / content / retry-exhaust).
- `image-gen-multi:chain_exhausted` — todos los providers fallaron.

En `RunViewer.tsx`, mostrar al usuario por escena:
- `✓ Escena 5 generada con gemini:flash-image-3.1 (2.3s)`
- `↩ Escena 5: vertex:fast quota-exhausted, intentando gemini:flash-image-3.1`

Mejora dramática en la experiencia: el usuario ve EXACTAMENTE qué pasó cuando algo falla.

### Paso 5 — Pedir aumento de cuota Vertex (background, no es código)

**URL:** https://console.cloud.google.com/iam-admin/quotas?project=gen-lang-client-0913919937

1. Filtro: `online_prediction_requests_per_base_model`.
2. Para cada base model (`imagen-4.0-fast-generate`, `imagen-4.0-generate`, `imagen-4.0-ultra-generate`): EDIT QUOTAS → solicitar **200 RPM** con justificación.
3. Aprobación típica: horas a días.

**No bloquea nada del plan** — el resto funciona sin esto. (Detalles en `05-vertex-quota-strategy.md`.)

### Paso 6 — Ruteo del chain por estilo de preset (opcional, mejora de calidad)

**Archivos a tocar:** `packages/contracts/src/preset.schema.ts`, `pipeline.ts`.

Agregar al schema del preset:
```ts
imageGenStrategy: z.enum(['illustrated', 'photorealistic', 'sensitive', 'default']).optional()
```

En `pipeline.ts`, reordenar `providerChain` según `preset.imageGenStrategy`:
- `illustrated` → **Gemini → Imagen → OpenAI (al final)**.
- `photorealistic` → **OpenAI → Imagen std/ultra → fal Flux Pro**.
- `sensitive` → **Gemini → Higgsfield → fal → OpenAI (al final)**.
- `default` → orden actual (OpenAI primero).

Presets existentes quedan en `default` hasta que se vayan migrando. **Mejora de calidad por escenario, no resuelve confiabilidad** — por eso es opcional.

(Análisis por escenario en `03-provider-comparison.md`.)

## Riesgos / consideraciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| El field del aspect ratio en Gemini Image (REST) no es exactamente `responseFormat.image.aspectRatio` | Media | Smoke test antes de wire-up. ~30 min. |
| Gemini Image SÍ rechaza el preset pediátrico/médico (igual que OpenAI) | Baja | Cascada cae a Higgsfield/fal. Plan sigue robusto. |
| El proyecto `gen-lang-client-*` tiene cuotas BAJAS también para Gemini Image | Baja-media | Misma cascada actúa; eventualmente pedir aumento de Gemini RPM. |
| Cockatiel sería más limpio que Bottleneck pero el plan elige Bottleneck | Bajo | Cockatiel es mejora futura. Bottleneck cubre el throttle inmediato sin reescritura mayor. |
| Costo total del rip aumenta vs Vertex Imagen fast ($0.02/img) | Bajo | Diferencia ~$0.50/rip. Dentro de budget. |

## Lo que NO incluye este plan

- **Estrategias de prompt engineering** para evitar safety filters de cada provider (doc 06 pendiente — relevancia secundaria).
- **Pricing detallado de Higgsfield y fal** — no crítico, valores en orden esperado.
- **Re-arquitectura completa con Cockatiel** — el plan elige Bottleneck para mínima invasión; Cockatiel queda como mejora futura.
- **Reorganización del provider creation logic** — `pipeline.ts` arma el chain inline; vale modularizar pero no es crítico.
- **Cambios al scene-animator / video-gen-veo** — esos están bien (Kling primario funciona). Out of scope.

## Métricas de éxito (medibles post-implementación)

| Métrica | Antes | Objetivo |
|---|---|---|
| % de rips que se completan sin intervención manual | ~50% (estimado en presets sensibles) | **100%** |
| Tiempo entre primer 429 y rip completado | 5+ min (al fallar tras 5 retries) | < 30s (skip inmediato a próximo provider) |
| Visibilidad de qué provider generó cada escena | ninguna en UI | logueado por escena, visible en RunViewer |
| Costo promedio de imágenes por rip de 22 escenas | $0.44-$2.95 según provider | $0.85-$1.00 (Gemini primario) |
| Capacidad de testar nuevos providers | reescribir block | agregar a chain en una línea |

## Próximos pasos (cuando confirmes)

Orden de ejecución sugerido:

1. **Paso 1 (fix bugs).** Más impacto, menos código. Probable con un commit.
2. **Paso 2 (`GeminiImageProvider`).** Provider nuevo, calidad para ilustrado.
3. **Paso 3 (throttling per-provider).** Profilaxis para no causar el problema.
4. **Paso 4 (telemetría).** Diagnostico para problemas futuros + UX.
5. **Paso 6 (ruteo por preset).** Mejora opcional.
6. **Paso 5 (form de cuota).** En paralelo desde el inicio.

**Antes de empezar:** cargar las respuestas de Claude Deep Research y ChatGPT (cuando las tengas) como `EXT-claude-research.md` y `EXT-chatgpt-research.md` en esta carpeta. Si traen ideas que cambien el plan, las integro acá antes de codear.
