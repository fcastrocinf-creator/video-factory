# Marcas (Brands)

Configuraciones JSON de las marcas D2C del owner. Validadas con `BrandConfigSchema` de `@video-factory/contracts`.

## Cómo agregar una marca nueva

1. Crear `<id>.brand.json` en este directorio.
2. Llenar los campos siguiendo `BrandConfigSchema` (ver `packages/contracts/src/brand.schema.ts`).
3. El `voiceId` se obtiene del dashboard de ElevenLabs → Voices → click en voz → copy voice ID.
4. Los `brandColors` se usan en subtítulos kinéticos como acentos (highlight).
5. Las `toneRules.avoid` y `toneRules.prefer` se usan en el bloque `script-processor` para validar el guión.

## Marcas activas

| ID | Display name | Idioma | Estado |
|---|---|---|---|
| `vitaly` | Vitaly | es-CL | MVP |

> **Nota sobre el `voiceId` de Vitaly:** el valor `EXAVITQu4vr4xnSDxMaL` corresponde a "Bella" (ejemplo). Reemplazar por el ID real de la voz Valentina (o la que use el owner en producción) antes de generar videos finales.
