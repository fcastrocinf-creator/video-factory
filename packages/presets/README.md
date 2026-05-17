# Presets visuales

Configuraciones JSON de presets de estilo visual. Validadas con `PresetConfigSchema` de `@video-factory/contracts`.

Cada preset es una combinación coherente de:
- **Clasificación** (formato, hook angulo, funnel stage, awareness)
- **Estrategia** (`plano_fijo` o `multi_escena`)
- **Engine visual** (Imagen 4, Veo 3.1 Lite/Fast/Standard, Higgsfield)
- **Estilo de prompt** + negative prompt
- **Subtítulos** (estilo, fuente, colores, posición)
- **Composición** (Ken Burns, música)

## Cómo agregar un preset nuevo

1. Crear `<id>.preset.json` en este directorio.
2. Llenar los campos siguiendo `PresetConfigSchema` (ver `packages/contracts/src/preset.schema.ts`).
3. Verificar que el `visualEngine` esté soportado por algún bloque image-gen o video-gen.
4. Probar el `promptTemplate` con una generación de imagen aislada antes de usarlo en pipeline completo.

## Presets activos

| ID | Display name | Estrategia | Engine | Funnel |
|---|---|---|---|---|
| `educativo_pixar` | Educativo · Doctor Pixar | plano_fijo | imagen4 | TOFU |

## Convenciones de naming

`{formato}_{estilo_visual}` o `{formato}_{persona}_{estilo}`.

Ejemplos:
- `educativo_pixar` → formato educativo + estilo Pixar
- `ugc_kitchen_testimonio` → formato UGC + escenario cocina + ángulo testimonio
- `storytelling_acuarela_medica` → formato storytelling + estilo acuarela médica
