# 06 — Estrategias de safety filters y content policy

> Síntesis de hallazgos propios + research externa (Claude Deep Research, ver `EXT-claude-research.md` §6). Cubre el tema crítico de qué proveedor usar para qué tipo de contenido, y cómo escribir prompts que no se choquen con filtros legítimamente (sin jailbreaks).

## Ranking empírico de permisividad (peor → mejor para producción)

Para contenido **legítimo-pero-sensible** (médico, productos infantiles, anatomía en contexto de producto):

| # | Provider | Comportamiento | Veredicto |
|---|---|---|---|
| 1 | **OpenAI gpt-image-1** | El **más agresivo**. Microsoft Q&A docs reportan bloqueos falsos en escenas "niño + perro en playa". Scanea PROMPT Y OUTPUT y falla silenciosamente. | **Nunca primary** en health/pediatric/sensitive. |
| 2 | **Google Imagen 4 / Gemini Nano Banana** | Strict en términos anatómicos (bloquea "skin", "body parts"), pero generalmente pasa framings educativos/médicos. Default-safe para D2C consumer products incluyendo baby goods, **siempre que los prompts usen lenguaje parental/branded**. | **Default-safe** para la mayoría de presets de marca. |
| 3 | **BFL Flux 2 Pro** | El **más permisivo** de las commercial APIs major. `safety_tolerance: 2` es el production-balanced setting. Fuerte en escenas con real-people que gpt-image-1 rechazaría. | **Primary** para escenarios sensitive cuando Nano Banana también rechaza. |
| 4 | **fal.ai-hosted open models** (Flux Dev, SDXL, Wan) | El **más permisivo overall**; appropriate como fallback only porque también son los lowest brand-control. | **Emergency lane** — "render anything legitimate". |

(Fuente: Claude Deep Research — `EXT-claude-research.md` §6 + observaciones empíricas del propio Video Factory: el test del preset doctor + bebé tumbó OpenAI en patrón consistente con #1.)

## Tabla de ruteo por tipo de contenido

| Preset / contenido | Primary | Secondary | Tertiary |
|---|---|---|---|
| **Foto-realista** (D2C product, lifestyle) | Nano Banana | BFL Flux 2 Pro direct | fal.ai Flux 2 Pro |
| **Ilustración / cartoon** | Recraft V3 (`digital_illustration`) | Nano Banana | Ideogram V3 |
| **Comic / estilizado** | Nano Banana | Ideogram V3 | Recraft V3 (`vector_illustration`) |
| **Poster con texto** | Ideogram V3 | Gemini 3 Pro Image | Recraft V3 |
| **Médico / pediátrico / salud** | Nano Banana | BFL Flux 2 Pro | fal.ai Flux Dev — **NEVER gpt-image-1** |
| **Emergencia (todos fallaron)** | Recraft V3 (`realistic_image`) | fal.ai Flux Dev | Nano Banana |

## Prompt engineering — patrones permitidos (sin jailbreaks)

### 1. Reemplazar terminología clínica por lenguaje brand/role

- ❌ `"doctor expert"` → puede triggerar
- ✅ `"smiling healthcare professional in white coat reviewing product label"`

- ❌ `"pediatric"` → puede triggerar
- ✅ `"for parents and small children, family-friendly setting"`

- ❌ `"baby's mouth"` → triggers anatomical filter
- ✅ `"baby teether held by parent's hand"`

### 2. Incluir frases de non-violation cuando el contexto es borderline

Agregar al final del prompt:
- `"wholesome family photography, soft daylight, professional advertising style"`
- `"safe-for-work, brand-appropriate, consumer marketing aesthetic"`

### 3. Usar prompts estructurados (subject + action + context + style)

La guía de BFL recomienda explícitamente esta estructura y **disallows negative prompts** — nunca escribir "no violence", "no nudity" porque el filter ve la palabra y la cuenta como contexto relevante.

✅ Estructura recomendada:
```
[SUBJECT]: a parent holding a baby toy
[ACTION]: smiling gently, looking at the product
[CONTEXT]: warm sunlit living room, soft daylight from window
[STYLE]: professional advertising photography, brand-warm color palette, vertical 9:16 frame
```

### 4. Pre-flight classifier (mejora avanzada)

Para presets flagged como sensitive (medical, children, health), correr un **Gemini Flash classifier** ANTES de pegar al image generator:

```ts
// Pseudocódigo
const riskScore = await classifyPromptRisk(prompt, ['medical', 'pediatric', 'anatomy']);
if (riskScore > 0.7) {
  prompt = await rewritePromptSafely(prompt);
}
```

Costo: ~$0.0001 por escena. Worth it si los content rejections exceden 5% en un preset.

## Patrón a evitar: el "anti-prompt-engineering"

Algunos providers (gpt-image-1 incluido) detectan intentos de jailbreak/disambiguation que suenan **"demasiado explícitos"**. Si tu prompt agrega cosas como:
- `"this is for educational purposes only"`
- `"safe and non-explicit"`
- `"not pornographic in any way"`

…el filter puede leerlas como **señales de que ESTÁS intentando sortear el filter**, y rechazar por eso.

**Regla:** las disambiguaciones deben sonar a brand/contexto natural, no a disclaimers.

## Cuando un provider rechaza por content: qué hacer en el código

(Ver también `01-image-gen-multi-block-analysis.md` y `99-PLAN-FINAL.md`.)

El `ImageGenMultiBlock` actual ya tiene la lógica correcta para `isContentRejection=true` (líneas 301-327 de `block.ts`):

1. Marcar el step como exhausted PARA ESTE PROMPT (no para toda la rip — el siguiente prompt podría pasar).
2. Saltar al próximo provider del chain inmediatamente.
3. Si todos rechazan: aplicar el "safety constraint" sanitization hint y reintentar el OUTER loop.
4. Como último resort: render un safe placeholder abstract (background-only, sin people/objects).

Esta lógica está bien implementada. Lo que falta:

- **Pre-flight classifier** (opcional, mejora — sección "4" arriba).
- **Mejor mapping en `VertexImagenProvider`** (ya lo tiene en el caso `200 sin bytes`, `vertex-provider.ts:160-172`, pero podría también detectar safety filter en bodies con `raiFilteredReason`).
- **`OpenaiImageProvider` ya está correcto** (líneas 130-134 detectan "safety system | content policy | moderation | rejected | not allowed | inappropriate").

## Conexión con el plan final (doc 99)

El §6 de `EXT-claude-research.md` y este doc refuerzan tres decisiones de `99-PLAN-FINAL.md`:

1. **Nano Banana como primary** para todos los presets excepto los foto-realistas estrictos — su balance permisividad/calidad es el mejor del lote.
2. **OpenAI gpt-image-1 al final del chain** (o fuera, para presets sensibles) — NUNCA primary en medical/pediatric.
3. **Ruteo por estilo de preset** (paso 6 del plan) — la tabla de arriba es el contenido concreto de ese ruteo.

## Fuentes

- Claude Deep Research — `EXT-claude-research.md` §6.
- BFL prompting guide (referenciado por Claude; verificar en `bfl.ai/docs` al integrar).
- Microsoft Q&A reports sobre rejection patterns de gpt-image-1 (referenciado por Claude).
- Empirical observations del propio Video Factory (preset `doctor_broll_animado_comic_sepia` + bebé tumbó OpenAI en testing — patrón consistente con el ranking #1 worst).
