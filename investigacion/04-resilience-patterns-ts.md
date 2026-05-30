# 04 — Patrones de resilience en TypeScript

> Para implementar una cascada multi-provider robusta necesitamos tres cosas que el código actual no tiene (o tiene a medias): (1) retry-with-backoff por proveedor con políticas distintas, (2) rate limiting POR PROVEEDOR (no un único `MIN_INTERVAL_MS` global), (3) circuit breaker para no pegarle a un proveedor caído. Esta investigación lista las librerías maduras de Node/TS y su aplicabilidad a nuestro caso.

## Librerías evaluadas

### Cockatiel — la opción más completa ⭐

**`cockatiel`** (Microsoft / connor4312) — la librería de referencia para resilience en Node/TS.

- URL: https://github.com/connor4312/cockatiel
- npm: https://www.npmjs.com/package/cockatiel

**Qué ofrece (todo combinable):**
- `retry` — retry con backoff (constant, exponential, decorrelated jitter)
- `circuitBreaker` — circuit breaker con threshold de fallos consecutivos
- `timeout` — wrap con timeout
- `bulkhead` — limitar concurrencia (max in flight) — equivale al rate limit por concurrency
- `fallback` — fallback a otro handler en caso de falla
- `wrap` — combinar políticas (`wrap(retry, circuit, bulkhead, timeout)`)

TypeScript-native, mantenida activamente, usada en SDKs de Azure. Sin dependencias pesadas.

**Aplicación a nuestro caso (pseudocódigo):**

```ts
import {
  retry, circuitBreaker, ConsecutiveBreaker, ExponentialBackoff,
  handleAll, handleType, wrap, bulkhead,
} from 'cockatiel';

// Una policy por provider, combinando:
// - retry con backoff exponencial
// - circuit breaker (trip al ver N fallos consecutivos)
// - bulkhead (max in flight)
const vertexPolicy = wrap(
  retry(handleAll, { maxAttempts: 2, backoff: new ExponentialBackoff({ initialDelay: 8000 }) }),
  circuitBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(3) }),
  bulkhead(2),
);

// Cada llamada al provider va envuelta:
const buffer = await vertexPolicy.execute({ signal }, () => vertexProvider.generate(req));
```

### Bottleneck — rate limiting fino

**`bottleneck`** — rate limiter clásico de Node, complementario a Cockatiel.

URL: https://github.com/SGrondin/bottleneck

Útil cuando necesitamos rate-limit por tiempo (X requests/segundo) además del bulkhead por concurrencia. Cockatiel `bulkhead` controla "cuántos al mismo tiempo", Bottleneck controla "uno cada X ms".

```ts
import Bottleneck from 'bottleneck';

const vertexLimiter = new Bottleneck({
  minTime: 1200,        // ~50 RPM nominal (un request cada 1.2s)
  maxConcurrent: 2,
});

await vertexLimiter.schedule(() => vertexPolicy.execute(() => vertexProvider.generate(req)));
```

### @carbonteq/resilience — alternativa más liviana

URL: https://www.npmjs.com/package/@carbonteq/resilience

Similar a Cockatiel pero más liviano. Combina circuit breaker + rate limiter de forma integrada. Razonable si queremos menos dependencias y no necesitamos toda la suite de Cockatiel.

### p-retry, p-queue — building blocks mínimos

- `p-retry` — promise retry minimalista.
- `p-queue` — concurrency queue para promesas.

Para hacerlo sin frameworks, estas dos cubren lo básico. Pero Cockatiel hace lo mismo con más prolijidad y APIs más expresivas.

## Recomendación para Video Factory

**Adoptar Cockatiel** (+ opcionalmente Bottleneck para tiempo entre requests) para envolver cada provider del chain.

### Arquitectura propuesta

```ts
// 1. Una política por nombre de provider — refleja sus límites y caracter
const providerPolicies: Record<string, Policy> = {
  'openai': wrap(
    retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff({ initialDelay: 4000 }) }),
    circuitBreaker(handleAll, { halfOpenAfter: 120_000, breaker: new ConsecutiveBreaker(5) }),
    bulkhead(5),
  ),
  'vertex-imagen': wrap(
    // Menos retries: la cuota Vertex es baja, retry no ayuda
    retry(handleAll, { maxAttempts: 1, backoff: new ExponentialBackoff({ initialDelay: 8000 }) }),
    // Trip rápido: si falla 3 veces seguidas, no le pegamos por 60s
    circuitBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(3) }),
    bulkhead(2),
  ),
  'gemini-image': wrap(
    retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff() }),
    circuitBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(8) }),
    bulkhead(10),
  ),
  'higgsfield': wrap(...),
  'fal':        wrap(...),
};

// 2. El chain itera por providers y aplica la política de cada uno
async function generateWithChain(req: ImageGenerationRequest): Promise<Buffer> {
  const errors: Array<{ provider: string; err: Error }> = [];
  for (const step of providerChain) {
    const policy = providerPolicies[step.providerName] ?? defaultPolicy;
    try {
      const buffer = await policy.execute({ signal }, () => step.provider.generate(req));
      return buffer;
    } catch (e) {
      // La política falló (retries agotados / circuit open / etc.) → próximo step
      errors.push({ provider: step.providerName, err: e as Error });
      logger.warn(
        { provider: step.providerName, err: (e as Error).message.slice(0, 200) },
        'image-gen-chain:step_failed_trying_next',
      );
      continue;
    }
  }
  throw new AggregateError(errors.map((x) => x.err), 'All providers exhausted');
}
```

**Ventajas vs el código actual (`block.ts:244-353`):**

1. **Throttle real por proveedor** — no un único `MIN_INTERVAL_MS = 6500` global. Cada provider respeta su propio cap (Vertex 50 RPM, OpenAI variable, Gemini 1000+ RPM).
2. **Circuit breaker** — si Vertex está caído (3 fallos seguidos), el "circuito se abre" y los siguientes intentos van directo a fallback durante 60s, sin pegarle a Vertex. Hoy el código sigue insistiendo.
3. **Bulkhead** — límite explícito de in-flight por proveedor; una clase de error no envenena todo.
4. **Skip al próximo proveedor cuando la política falla** — **resuelve Bug 2** del análisis (`01-image-gen-multi-block-analysis.md`).

## Trade-offs

- **Dependencias nuevas:** `cockatiel` (~30KB) + opcionalmente `bottleneck` (~50KB). Total trivial vs node_modules existente.
- **Reescribir parte del block:** el `callProviderWithApiRetry` actual se simplificaría drásticamente — la lógica de retry y de skip-al-siguiente queda externalizada en las policies.
- **Aprendizaje:** Cockatiel tiene API expresiva pero requiere leer docs. ~1 día de ramp-up.

## Patrón híbrido: mantener el chain custom + envolver providers con cockatiel

Una alternativa MENOS invasiva: mantener `ImageGenMultiBlock` como está (con su `exhaustedSteps`, su validation loop, su error memory), pero envolver cada `provider.generate()` con una política Cockatiel **dentro** de `callProviderWithApiRetry`. Eso resuelve:
- El retry-per-provider con backoff configurable.
- El circuit breaker (si un provider 429ea 3 veces, se considera "exhausted" temporalmente).
- El bulkhead.

Sin tocar la lógica de cascada de scene-level / validation. Más conservador. Recomendable como **primer paso**.

## Recurso adicional muy aplicable

**Artículo Medium relevante (TypeScript, mismo patrón aplicado a Anthropic LLM):**  
"Circuit Breaker for LLM with Retry and Backoff — Anthropic API Example (TypeScript)" — Szymon Pacholski.

URL: https://medium.com/@spacholski99/circuit-breaker-for-llm-with-retry-and-backoff-anthropic-api-example-typescript-1f99a0a0cf87

El patrón es 1:1 transferible a image-gen multi-provider.

## Fuentes

- [cockatiel — connor4312/cockatiel (GitHub)](https://github.com/connor4312/cockatiel)
- [cockatiel — npm](https://www.npmjs.com/package/cockatiel)
- [@carbonteq/resilience — npm](https://www.npmjs.com/package/@carbonteq/resilience)
- [carbonteq/resilience — GitHub](https://github.com/carbonteq/resilience)
- [Bottleneck — SGrondin/bottleneck (GitHub)](https://github.com/SGrondin/bottleneck)
- [API Resilience: Circuit Breakers, Retries, Bulkheads 2026 — APIScout](https://apiscout.dev/blog/api-resilience-circuit-breakers-retries-bulkheads-2026)
- [Circuit Breaker & Retry Patterns in Node.js (2026) — 1xAPI](https://1xapi.com/blog/resilient-api-circuit-breaker-bulkhead-retry-nodejs-2026)
- [Circuit Breaker for LLM in TS — Medium (Pacholski)](https://medium.com/@spacholski99/circuit-breaker-for-llm-with-retry-and-backoff-anthropic-api-example-typescript-1f99a0a0cf87)
- [Working with Rate Limits in Third-Party APIs — API7.ai](https://api7.ai/learning-center/api-101/working-with-rate-limits-in-third-party-apis)
