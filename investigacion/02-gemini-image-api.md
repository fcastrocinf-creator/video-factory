# 02 — Gemini Image API — specs vigentes (mayo 2026)

> Source: `https://ai.google.dev/gemini-api/docs/image-generation` (verificado vía WebFetch en esta investigación).

## Modelos disponibles

Tres modelos de la familia Gemini Image, todos en versión `*-preview` salvo el flash más viejo:

| Model ID | Codename | Estado | Recomendación |
|---|---|---|---|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 | preview, el más nuevo | **el que usaríamos como primario** — más rápido y barato que pro, multi-aspect ratio amplio |
| `gemini-3-pro-image-preview` | Nano Banana Pro | preview | alta calidad cuando hace falta más detalle (más caro) |
| `gemini-2.5-flash-image` | Nano Banana | estable (no preview) | fallback maduro si los preview dan problemas |

## Endpoint (AI Studio / Gemini API)

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

Reemplazando `{model}` por uno de los IDs de arriba.

## Autenticación

Header `x-goog-api-key: <GOOGLE_AI_API_KEY>` — la key ya existente del proyecto funciona, y al estar billing habilitado en `gen-lang-client-0913919937` queda automáticamente en **tier pago** (límites altos).

## Request body — ejemplo mínimo

```json
{
  "contents": [
    {
      "parts": [{ "text": "Hand-illustrated digital painting in warm sepia-watercolor style ..." }]
    }
  ],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
```

## Aspect ratios soportados

**9:16 (vertical) está soportado** ✅ — lo que necesitamos para el pipeline.

Lista completa para `gemini-3.1-flash-image-preview`:
> 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9

Se solicita vía `responseFormat.image.aspectRatio` en SDKs Python/JS, o vía `response_format` en REST.

> ⚠️ El doc oficial menciona el field pero no muestra el ejemplo concreto en REST puro. Habría que testearlo. Más probable: agregar al body algo como `"responseFormat": {"image": {"aspectRatio": "9:16"}}` o `"generationConfig": {"image": {"aspectRatio": "9:16"}}`.

## Response

Los bytes de la imagen vienen en:

```
candidates[0].content.parts[].inline_data.data    // base64 de la imagen
parts[].inline_data.mimeType                       // ej. "image/png"
```

Para iterar las `parts` y encontrar la imagen: cada `part` puede ser texto O imagen; hay que filtrar por presencia de `inline_data`.

## Image editing (image-to-image) — bonus

El modelo **soporta edición de imágenes existentes** (`text-and-image-to-image`). Se puede pasar una imagen como input y pedirle modificaciones, cambios de estilo, etc.

Esto es **directamente relevante** para el `rip-fidelity-aligner` del proyecto, que hoy compara iterativamente cada imagen generada contra un keyframe de referencia y refina prompts hasta lograr ≥95% similitud. Con Gemini Image en modo edit, se podría:
- Empezar con la imagen del keyframe original.
- Pedir a Gemini "adaptá esto al producto X manteniendo composición/estilo".
- Una sola pasada en vez de iterar 3-5 veces con regeneración.

Potencial ahorro en latencia y costo en el modo "Ripeo fiel".

## Content / safety policy

El doc remite a [Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy). No enumera categorías específicas en la página principal de image-generation.

**Observación empírica (a verificar):** Gemini Image tiende a ser más permisivo que gpt-image-1 en contextos médicos / educativos legítimos. La política de Google para Gemini distingue "uso educativo / informativo" de "contenido dañino" con más matices que las reglas blanket de OpenAI para gpt-image-1 con contenido pediátrico.

A confirmar en testing: si el preset doctor + bebé que falló por OpenAI pasa por Gemini Image sin content-rejection.

## Pricing y rate limits

⚠️ **No documentados en la página principal de image-generation.** El doc remite a:
- `https://ai.google.dev/pricing` (precios)
- `https://ai.google.dev/gemini-api/docs/rate-limits` (límites)

Estos datos los relevo en una segunda búsqueda — ver actualizaciones posteriores a este doc.

## Diferencias clave vs Imagen 4

| | Imagen 4 (Vertex / AI Studio) | Gemini Image (Nano Banana) |
|---|---|---|
| Modelo entrenado para | text-to-image puro | multimodal nativo (texto + imagen) |
| Aspect ratios | algunos (1:1, 9:16, 16:9, 3:4, 4:3) | 14+, incluido 9:16 |
| Image editing | no (necesita pipeline aparte) | sí, nativo |
| Endpoint | `aiplatform.googleapis.com` (Vertex) o `generativelanguage` (AI Studio) | `generativelanguage` con `gemini-*:generateContent` |
| Cuota | `online_prediction_requests_per_base_model` (Vertex — bajo en proyectos AI-Studio-derived) | Cuota Gemini estándar (alta en tier pago) |
| Estilo "comic / acuarela / sepia" | bueno | bueno-excelente |
| Filtro de contenido (empírico) | medio-estricto | más permisivo |

## Implementación esperada como `ImageProvider`

Pseudocódigo del provider implementando la interface `ImageProvider` existente (`provider.ts:17-22`):

```ts
// packages/blocks/image-gen-imagen/src/gemini-image-provider.ts

export interface GeminiImageProviderOptions {
  apiKey: string;
  defaultModel?: string;  // default 'gemini-3.1-flash-image-preview'
  name?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiImageProvider implements ImageProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiImageProviderOptions) {
    this.name = opts.name ?? 'gemini-image';
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel ?? 'gemini-3.1-flash-image-preview';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    const model = req.model ?? this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const body = {
      contents: [{ parts: [{ text: req.prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        // TODO confirmar sintaxis exacta del aspect ratio en REST:
        responseFormat: { image: { aspectRatio: req.aspectRatio } },
      },
    };

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const bodyText = await resp.text();
      const isQuotaExhausted =
        resp.status === 429 &&
        /quota.*exceeded|RESOURCE_EXHAUSTED/i.test(bodyText);
      const isContentRejection =
        resp.status === 400 &&
        /safety|policy|prohibited|blocked/i.test(bodyText);
      throw new ImageProviderError(
        `Gemini Image ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
        resp.status,
        bodyText,
        resp.status === 429 || resp.status >= 500,
        isQuotaExhausted,
        this.name,
        isContentRejection,
      );
    }

    const data = await resp.json();
    const part = data.candidates?.[0]?.content?.parts?.find(
      (p: any) => p.inline_data || p.inlineData,
    );
    const inlineData = part?.inline_data ?? part?.inlineData;
    if (!inlineData?.data) {
      // 200 sin imagen → safety filter casi seguro → isContentRejection
      throw new ImageProviderError(
        `Gemini Image: 200 sin inline_data (probable safety filter): ${JSON.stringify(data).slice(0, 300)}`,
        200,
        JSON.stringify(data).slice(0, 500),
        false,
        false,
        this.name,
        true,   // isContentRejection
      );
    }
    return Buffer.from(inlineData.data, 'base64');
  }
}
```

~150 líneas estimadas con tests y docstrings. Sigue exactamente el patrón de `GoogleImagenProvider` y `OpenaiImageProvider`.

## Integración al chain (`pipeline.ts`)

El cambio en `pipeline.ts:339-389` sería insertar Gemini justo después de OpenAI y antes de Vertex:

```ts
// (después del bloque que crea OpenAI provider)

// Gemini Image (Nano Banana 2) — cuota Gemini, no choca con cuotas de Imagen
if (googleApiKey) {
  const geminiImageProvider = new GeminiImageProvider({ apiKey: googleApiKey });
  providerChain.push({
    provider: geminiImageProvider,
    model: 'gemini-3.1-flash-image-preview',
    label: 'gemini:flash-image-preview-3.1',
  });
  // Opcional: agregar también flash-image-2.5 como fallback dentro de Gemini:
  providerChain.push({
    provider: geminiImageProvider,
    model: 'gemini-2.5-flash-image',
    label: 'gemini:flash-image-2.5',
  });
}

// (después se construye el resto del chain — Vertex, AI Studio, etc.)
```

## Pendiente de confirmar antes de codear

- [ ] Precio exacto por imagen (tier pago) — pendiente WebFetch.
- [ ] RPM/RPD exactos (tier pago) — pendiente WebFetch.
- [ ] Sintaxis exacta del aspect ratio en REST body (`responseFormat.image.aspectRatio` o variante) — testear con `curl` o un script smoke.
- [ ] Comportamiento exacto del safety filter con contenido pediátrico/médico — testear con el prompt del preset doctor que falló por OpenAI.
- [ ] Confirmar que la key `GOOGLE_AI_API_KEY` existente sirve para el modelo `gemini-3.1-flash-image-preview` (no es un modelo restricto a allowlist).
