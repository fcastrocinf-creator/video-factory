---
name: video-intelligence
description: Comprensión PROFUNDA de videos/ads para Video Factory. Úsala SIEMPRE que el owner pida analizar, aprender, ripear o entender un video/ad — su guión, escenas, cortes, texto en pantalla, voces, antes/después, PiP/overlays o estructura. Combina Gemini 2.5 Pro nativo (ve + OYE + tiempo) con el motion-map propio (cortes + animado/estático) y persiste el formato aprendido.
---

# Video Intelligence — capa de percepción de video (Video Factory)

Cuando haya que ENTENDER un video (aprender un formato, ripear, auditar un render), NO te quedes con
unos pocos keyframes estáticos. Usa esta capa:

## Cómo
```
npx tsx scripts/video-intelligence.ts "<ruta-al-video>"
```
Eso ejecuta `apps/web/lib/video-intelligence.ts` → `analyzeVideoDeep`, que orquesta lo que YA existe:

1. **Núcleo — Gemini 2.5 Pro NATIVO** (`apps/web/lib/ad-analyzer.ts` → `analyzeAd`): sube el video y lo
   entiende **completo (visual + AUDIO + tiempo)** → guión transcrito, escenas con timestamps,
   narrador, producto, claim, línea editorial, hook, CTA, estilo, PiP/overlays, estilo de captions.
   Usa `GOOGLE_AI_API_KEY`. *(La key de OpenAI/Whisper no tiene cupo — el audio viene de Gemini.)*
2. **motion-map propio** (`apps/web/lib/motion-map.ts`): detecta **cortes** (cambios de plano) y tramos
   **animado vs estático** por frame-diff.
3. **Persistencia**: guarda el reporte en `storage/kb/formatos/<video>.json` + un evento KB
   (subsistema `aprendizaje`) → memoria que MEJORA con cada video aprendido.

## Apoyo visual (opcional)
Para confirmar a ojo, extrae un mosaico denso de frames con el ffmpeg de Remotion
(`-vf scale=... -r N`, muxer image2) y míralo con Read. Útil para microframes / PiP.

## Reglas
- **NO inventes** lo que no se ve/oye; marca lo incierto.
- **Reusa**, no dupliques: `ad-analyzer` (Gemini), `motion-map`, `frame-extractor`, `video-understander`.
- ffmpeg del proyecto es el recortado de Remotion (sin filtros de escena/chromakey ni muxer rawvideo):
  extracción PNG (image2) sí; análisis por píxel se hace en Node (ver `png-raw.ts`).
- Español neutro.

## Salida esperada
Guión + estructura plano-a-plano (timestamps) + elementos (producto, texto en pantalla, PiP, anotaciones,
antes/después, voces) + cortes + nivel de certeza. Es la base para "aprender/ripear el formato".

## Cómo evoluciona (capas a apilar)
- Panel **multi-agente** de verificación (`apps/web/lib/kb/format-audit.ts`) sobre el reporte.
- **Diarización** por hablante (quién habla y cuándo) y **detección de cara/zona** para anclar anotaciones.
- Segundo validador cruzado si hiciera falta. Cada mejora se suma aquí, no en un pipeline paralelo.
