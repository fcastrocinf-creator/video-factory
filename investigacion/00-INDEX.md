# Investigación — Video Factory

Carpeta donde guardamos **referencias, hallazgos y ideas de investigación** para
el proyecto.

> **Importante:** este contenido es para informar decisiones de implementación —
> NO es código del pipeline ni fuente de verdad del producto. La fuente de
> verdad sigue siendo `DOCUMENTO_MAESTRO.md` (arquitectura) y `HANDOFF.md`
> (estado actual). Las recomendaciones de esta carpeta se consolidan en
> `99-PLAN-FINAL.md` y se aplican al código sólo tras decisión explícita.

## Foco actual de investigación

**Arquitectura confiable de generación de imágenes multi-provider.** Motivado por:

1. 429 de Vertex Imagen en cuota `online_prediction_requests_per_base_model`.
2. La cascada de fallback no salta del proveedor caído al siguiente.
3. Falta automatización total — hoy un rip que falla requiere intervención manual.
4. Posible filtro de contenido de OpenAI (gpt-image-1) en pediátrico/médico
   no se está manejando como rechazo recuperable.

## Índice de documentos

| # | Archivo | Contenido | Estado |
|---|---|---|---|
| 00 | `00-INDEX.md` | este archivo | live |
| 01 | `01-image-gen-multi-block-analysis.md` | análisis del código de cascada actual (`ImageGenMultiBlock`) | pendiente |
| 02 | `02-gemini-image-api.md` | specs actuales de Gemini 2.5 Flash Image ("Nano Banana") | pendiente |
| 03 | `03-provider-comparison.md` | OpenAI gpt-image-1 / Imagen 4 / Gemini Image / Flux Pro / Ideogram / Recraft | pendiente |
| 04 | `04-resilience-patterns-ts.md` | librerías TS para retry, throttle, circuit breaker | pendiente |
| 05 | `05-vertex-quota-strategy.md` | manejo de cuotas Vertex Imagen + proyectos `gen-lang-client-*` | pendiente |
| 06 | `06-content-policy-strategies.md` | safety filters por proveedor + patrones de prompt seguros | pendiente |
| 07 | `07-opensource-references.md` | proyectos públicos con arquitecturas similares | pendiente |
| 99 | `99-PLAN-FINAL.md` | recomendación consolidada para implementar | pendiente |

## Convención

- Los archivos `01–07` son **hallazgos crudos**: citas, datos, links, fragmentos
  de código de referencia.
- El archivo `99-PLAN-FINAL.md` es la **síntesis opinada**: qué hacer, por qué, y
  en qué orden de implementación.
- Las respuestas de otras IAs (Claude Deep Research, ChatGPT, etc.) se anexan
  como archivos `EXT-*.md` (ej.: `EXT-claude-research.md`, `EXT-chatgpt-research.md`)
  para mantenerlas separadas de los hallazgos propios y no mezclarlas con el
  análisis directo.

## Última actualización

2026-05-22 — investigación arrancada.
