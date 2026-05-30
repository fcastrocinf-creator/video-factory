# 03 — Comparativa de providers de generación de imágenes

> Pricing extraído de `https://ai.google.dev/pricing` (Google, verificado en esta investigación) y conocimiento público de OpenAI/Higgsfield/fal. Rate limits públicos en `https://ai.google.dev/gemini-api/docs/rate-limits` **no exponen RPM/RPD por modelo** — Google redirige al dashboard del proyecto en AI Studio.

## Tabla comparativa (paid tier asumido)

| Provider | Model | Precio/imagen | Aspect 9:16 | Política de contenido | Notas |
|---|---|---|---|---|---|
| OpenAI | gpt-image-1 (medium) | **$0.04** | sí (1024×1536) | **Estricta** — rechaza pediátrico/médico con frecuencia | Latencia 15-30s; `isContentRejection` bien detectado en código actual |
| OpenAI | gpt-image-1 (high) | $0.17 | sí | estricta | Mejor calidad, caro |
| OpenAI | gpt-image-1 (low) | $0.011 | sí | estricta | Calidad baja — útil para A/B |
| Gemini | **2.5 Flash Image** ("Nano Banana") | **$0.039** std / $0.0195 batch | sí (14+ ratios) | media-permisiva | Multimodal nativo, **edit support** |
| Gemini | **3.1 Flash Image Preview** ("Nano Banana 2") | **$0.045** (0.5K) → $0.151 (4K) | sí (14+ ratios) | media-permisiva | **El más nuevo**; mejor calidad que 2.5 |
| Gemini | 3 Pro Image Preview | $0.134-$0.24 | sí | media-permisiva | Calidad pro, más caro |
| Vertex Imagen | 4 fast | **$0.02** | sí | media (RAI filter) | El MÁS BARATO, pero cuota muy baja en `gen-lang-client-*` |
| Vertex Imagen | 4 std | $0.04 | sí | media | Misma cuota baja por base model |
| Vertex Imagen | 4 ultra | $0.06 | sí | media | Misma cuota baja por base model |
| AI Studio Imagen | 4 (vía Gemini API) | ≈ Vertex | sí | media | Caps diarios en algunos tiers |
| Higgsfield | Flux Pro Kontext Max | a verificar (~$0.04 estimado) | parcial | permisiva | Buen fallback estilizado |
| fal.ai | Flux Pro v1.1 | ~$0.05 | sí | permisiva | Pay-per-use sin commit |
| fal.ai | Flux Dev | ~$0.025 | sí | permisiva | Calidad menor, último recurso |

## Costo por rip (22 escenas)

| Configuración | Costo de imágenes |
|---|---|
| Todo Imagen 4 fast | **$0.44** (mejor caso) |
| Todo Gemini 2.5 Flash Image | $0.86 |
| Todo Gemini 3.1 Flash Image Preview (0.5K) | $0.99 |
| Todo OpenAI gpt-image-1 medium | $0.88 |
| Todo Gemini 3 Pro Image Preview (1K-2K) | $2.95 |
| Higgsfield Flux Pro Kontext (estimado) | ~$0.88 |
| fal.ai Flux Dev | ~$0.55 |

**Todos los escenarios entran cómodamente en el budget de $5-10/rip.** El costo de imágenes es secundario; lo que duele es el COSTO DE FALLO (un rip que cae a la mitad gastó plata y no entregó).

## Análisis por escenario de uso

### Escenario 1: estilo ilustrado / comic / acuarela / sepia (preset doctor)

**Ranking recomendado:**
1. **Gemini 3.1 Flash Image Preview** — primario. Mejor calidad ilustrada del lote, multi-aspect-ratio, política permisiva, edit nativo.
2. **Gemini 2.5 Flash Image** — fallback Gemini (cuota distinta a la del preview).
3. **Imagen 4 fast / std** — barato y buena calidad ilustrada, pero la cuota baja en este proyecto lo hace inviable hasta resolver Bug 1 + pedir aumento.
4. **Higgsfield Flux Pro Kontext** — fallback robusto.
5. **OpenAI gpt-image-1** — al final del chain para este escenario: alto costo + alto riesgo de content-rejection en contextos médicos.

### Escenario 2: foto-realista / UGC / handheld

**Ranking recomendado:**
1. **OpenAI gpt-image-1 medium** — primario. Es donde más brilla.
2. **Imagen 4 std / ultra** — buena alternativa fotorealista una vez resuelto el quota issue.
3. **fal.ai Flux Pro v1.1** — fallback foto-realista bien testeado.
4. **Higgsfield Flux Pro** — fallback.
5. **Gemini Image** — al final: capaz pero no es su mejor escenario.

### Escenario 3: contenido sensible (médico, pediátrico, salud, productos íntimos)

**Ranking recomendado:**
1. **Gemini 3.1 Flash Image Preview** — política más matizada que OpenAI para uso educativo.
2. **Higgsfield Flux Pro** — más permisivo que la mayoría.
3. **fal.ai Flux Pro** — permisivo.
4. **Vertex Imagen** (con RAI filter en `block_some`) — medio permisivo.
5. **OpenAI gpt-image-1** — último, casi seguro rechaza.

### Ruteo inteligente por preset (mejora arquitectónica)

La conclusión: **distintos presets necesitan distintos primarios.** Hoy el `pipeline.ts:336-389` arma un chain ÚNICO sin preset-awareness. Una mejora futura:

- Cada `Preset` tendría un campo opcional `imageGenStrategy: 'illustrated' | 'photorealistic' | 'sensitive' | 'default'`.
- El builder del provider chain consulta ese campo y reordena los providers para que el escenario tenga su primario al frente.
- Si no hay strategy especificada, default = orden actual (OpenAI primario).

Esto es **mejora futura** — no es esencial para el fix inmediato (Bug 1 + Bug 2 + agregar Gemini Image).

## Datos sobre rate limits

**Verdad incómoda:** Google **no publica** los RPM/RPD exactos por modelo de imagen. El doc oficial de rate limits redirecciona a:
- Dashboard del proyecto: `https://aistudio.google.com/rate-limit?timeRange=last-28-days`
- Form para pedir aumento (paid tiers): `https://forms.gle/ETzX94k8jf7iSotH9`

Lo único concreto del doc: **batch enqueued token limits para `gemini-3.1-flash-image-preview`:**
- Tier 1: 1M tokens
- Tier 2: 250M tokens
- Tier 3: 750M tokens

(Estos son tokens en cola para batch API, NO el RPM síncrono que necesitamos.)

**Conclusión operacional:** los rate limits reales hay que **medirlos empíricamente** corriendo el sistema con telemetry, o ver el dashboard de AI Studio del proyecto (`gen-lang-client-0913919937`).

## Lo que falta confirmar

- [ ] Higgsfield Flux Pro: precio exacto y aspect ratio support.
- [ ] fal.ai Flux: precio por imagen para Pro v1.1 y Dev.
- [ ] RPM real de Gemini Image en paid tier (medición empírica + dashboard).
- [ ] AI Studio Imagen 4: tier daily caps actuales.
- [ ] Existencia y costo de Replicate, Ideogram, Recraft como alternativas adicionales (búsqueda pendiente).
