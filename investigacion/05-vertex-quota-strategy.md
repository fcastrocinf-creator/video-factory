# 05 — Estrategia de cuotas Vertex AI Imagen

> Hallazgo clave: el default oficial de `online_prediction_requests_per_base_model` en `us-central1` es **50 RPM** (requests por minuto) por proyecto + base model. Pero los proyectos creados por AI Studio (como `gen-lang-client-*`) pueden tener defaults aún más bajos, y Imagen 4 ahora usa **Dynamic Shared Quota (DSQ)** — Google asigna recursos según demanda global, así que el 429 puede aparecer aunque estés por debajo de 50 RPM nominal.

## Datos confirmados

### Default oficial

- **Quota:** `aiplatform.googleapis.com/online_prediction_requests_per_base_model`
- **Scope:** por proyecto, por **base model**, por región.
- **Default us-central1:** 50 RPM.
- **Enterprise (con aprobación):** hasta 500 RPM.
- **Algunos modelos pueden default a 0** — caso conocido: Veo 2.0 en `regional_online_prediction_requests_per_base_model`.

### Dynamic Shared Quota (DSQ)

Imagen 4 (fast / std / ultra) ahora opera bajo **Dynamic Shared Quota**:
- Google asigna recursos según demanda global, NO según una cuota fija por proyecto.
- **Beneficio:** alta disponibilidad cuando hay capacidad libre.
- **Contra:** el 429 puede aparecer aunque tu proyecto esté nominalmente bajo el cap, si hay demanda alta en la región o en el cluster en ese momento.
- No hay manera directa de "subir tu DSQ" — solo solicitar **Provisioned Throughput**.

### Provisioned Throughput

Modo de pago anticipado para alta concurrencia garantizada:
- Reservas capacidad por un período (ej. mensual).
- Costo significativamente mayor que pay-per-use.
- Recomendable solo cuando hay volumen sostenido alto y los 429 espurios son intolerables.
- **Para Video Factory en MVP: NO necesario.** El fix correcto es la cascada robusta.

## El caso específico de `gen-lang-client-0913919937`

Este es un proyecto **derivado de AI Studio** (no creado a mano en Cloud Console). Características típicas:
- Default quota más bajo que un proyecto enterprise creado normalmente — varios reportes de la comunidad mencionan defaults en orden de 5-10 RPM en estos proyectos para Vertex genAI.
- Algunas cuotas pueden empezar literalmente en 0 hasta solicitar habilitación.
- El billing está habilitado, así que técnicamente es paid tier — pero las cuotas iniciales son conservadoras hasta solicitar aumento.

**Verificación en vivo:** el usuario puede ver la cuota actual en:
```
https://console.cloud.google.com/iam-admin/quotas?project=gen-lang-client-0913919937
```
Filtrar por `online_prediction_requests_per_base_model` y mirar `current usage` vs `limit` por base model. Esto da números exactos para este proyecto.

## Solicitar aumento de cuota

### Form oficial

Para paid tier: https://forms.gle/ETzX94k8jf7iSotH9 (el doc oficial de Gemini API lo enlaza como "Rate limit increase form").

### Vía Cloud Console (Vertex AI específico)

1. `IAM & Admin` > `Quotas & System Limits`.
2. Filtro: `online_prediction_requests_per_base_model`.
3. Seleccionar la fila del modelo (`imagen-4.0-fast-generate-001`, `imagen-4.0-generate-001`, `imagen-4.0-ultra-generate-001` — cada uno tiene su propia row).
4. `EDIT QUOTAS` → solicitar nuevo límite con justificación de uso.
5. Tiempo de aprobación típico: horas a días, dependiendo del nuevo cap solicitado.

**Recomendación:** pedir **200 RPM** para los 3 modelos Imagen 4 — suficiente para rips de 22-30 escenas con throttling moderado, sin pedir el máximo de 500 (más probable de aprobar rápido).

## Estrategias por orden de preferencia

### Estrategia 1: NO depender de Vertex Imagen como primario para este proyecto ⭐ (la que recomiendo)

Dada la cuota baja por defecto + DSQ variable, **Vertex Imagen no es confiable como PRIMARIO**. Moverlo a fallback secundario o terciario en el chain, con primarios más robustos (Gemini Image, OpenAI gpt-image-1, Higgsfield).

- **Pro:** funciona inmediatamente sin esperar aprobaciones.
- **Contra:** Vertex Imagen 4 fast es el más barato ($0.02/img); usarlo solo como fallback significa que la mayoría de rips usan opciones algo más caras (~$0.04-0.045/img). Diferencia ~$0.50/rip. Tolerable.

### Estrategia 2: Solicitar aumento + mover a 200-500 RPM

Pedir 200-500 RPM en `online_prediction_requests_per_base_model` para los 3 modelos Imagen 4. Una vez aprobado, Vertex puede volver a ser primario o competir con Gemini.

- **Pro:** desbloquea el provider más barato.
- **Contra:** sujeto a aprobación de Google (horas-días); no resuelve el problema "ahora".

### Estrategia 3: Crear un proyecto GCP nuevo "limpio"

Crear un proyecto manualmente en Cloud Console (sin pasar por AI Studio), habilitar Vertex AI API, vincular billing. La hipótesis es que los proyectos creados a mano tienen defaults menos castigados que los derivados de AI Studio.

- **Pro:** posiblemente mejor punto de partida que `gen-lang-client-*`.
- **Contra:** complejidad de mantener dos proyectos GCP (service account, IAM, etc.) — y no está 100% confirmado que el default sea distinto.

**Investigación adicional recomendada antes de hacerlo** — probar primero las estrategias 1 + 2 + 4.

### Estrategia 4: Aceptar el límite de DSQ y diseñar para que no rompa ⭐⭐ (esencial)

Dado que DSQ es por naturaleza variable, **el diseño del sistema debe asumir 429 como evento normal**. Eso es exactamente lo que arregla Bug 1 + Bug 2 del análisis del bloque actual (`01-image-gen-multi-block-analysis.md`): detectar 429 → skip al próximo provider sin gastar retries.

**Esto NO es opcional** — independiente de qué tan alta sea la cuota Vertex, el sistema no puede asumir que SIEMPRE va a estar disponible. Combinar con Estrategia 1 o 2.

## Throttling para no ser nosotros el problema

Aunque Vertex pueda manejar X RPM, **el throttling es responsabilidad del cliente**:

```ts
// Bottleneck por proveedor (ver doc 04)
const vertexLimiter = new Bottleneck({
  minTime: 1200,        // ~50 RPM nominal — un request cada 1.2s
  maxConcurrent: 2,     // no más de 2 en vuelo simultáneo
});
```

Con esto, aunque haya 22 escenas en paralelo en el pipeline, las que van por Vertex se cuelan a un máximo de 50 RPM efectivo — sin reventar la cuota del cliente.

## Lo que NO resuelven cuotas

Incluso con quota infinita, hay casos donde Vertex Imagen falla:
- **RAI filter** (content rejection) — el preset doctor + pediátrico/médico puede activarlo. → marcar `isContentRejection=true` (el código ya lo hace para Vertex en el caso "200 sin bytes").
- **Modelo no disponible en la región** — error 404 / "model not found" puntual.
- **Errores transitorios 5xx** del lado Google.

Todos estos son normales en producción y deben caer al siguiente provider del chain (Bug 2 fix).

## Conexión con el Bug 1 del block

Específicamente: el `VertexImagenProvider.generate()` actual (en `vertex-provider.ts:142-156`) marca `isDailyQuotaExhausted=false` SIEMPRE. El fix con base en esta investigación:

```ts
// En vertex-provider.ts, en el catch del !resp.ok:
const isQuotaExhausted =
  resp.status === 429 &&
  /quota.*exceeded|RESOURCE_EXHAUSTED|online_prediction_requests_per_base_model/i.test(bodyText);

throw new ImageProviderError(
  `Vertex Imagen ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
  resp.status,
  bodyText,
  !isQuotaExhausted && (resp.status === 429 || resp.status >= 500),  // retryable solo si NO es quota
  isQuotaExhausted,                                                    // ← NUEVO
  this.name,
);
```

## Fuentes

- [Google Cloud — Generative AI quotas and system limits (Vertex)](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/quotas)
- [AIbase News — Google Imagen 4 and Imagen 4 Fast debuts on GCP Vertex Quota Menu (DSQ)](https://news.aibase.com/news/18207)
- [Governing Vertex AI GenAI / LLM Model Access With Quotas — Medium (Ferris Argyle)](https://medium.com/google-cloud/governing-vertex-ai-gen-ai-llm-model-access-via-quotas-19df2c53fccd)
- [GitHub issue — same error en `anthropic-claude-3-5-sonnet` vía Vertex (cg-dot/vertexai-cf-workers#18)](https://github.com/cg-dot/vertexai-cf-workers/issues/18)
- [Vertex AI veo-2.0-generate-001 quota 0 — Google Dev forums](https://discuss.google.dev/t/vertex-ai-veo-2-0-generate-001-quota-for-regional-online-prediction-requests-per-base-model-is-0/190466)
- [Firebase AI Logic — Rate limits and quotas](https://firebase.google.com/docs/ai-logic/quotas)
- [AI Studio Rate Limit dashboard (per project)](https://aistudio.google.com/rate-limit?timeRange=last-28-days)
- [Rate limit increase form (paid tiers)](https://forms.gle/ETzX94k8jf7iSotH9)
