# Investigación: GitHub topic `video-generator` → aplicabilidad a Video Factory

Fuentes: [`/topics/video-generator`](https://github.com/topics/video-generator), [`/topics/text-to-video`](https://github.com/topics/text-to-video), [`/topics/ai-video`](https://github.com/topics/ai-video). Filtro: >100 estrellas, actualización 2024-2026, relación con TS/Remotion o con alguno de los bloques nuestros.

---

## Hallazgo prioritario

**`shuyu-labs/BigBanana-AI-Director` (1.3k)** ataca la oportunidad #2 (multi-state character sheet) casi llave-en-mano. Su pipeline "Script → Asset → Keyframe → Final" tiene una fase 02 dedicada a *consistency assets*: genera "definite makeup photos" del personaje + biblioteca de props/escenas, y todas las generaciones de shot posteriores se condicionan contra esa biblioteca. Más interesante aún: producen video por **keyframe interpolation** (start frame + end frame → Veo interpola), lo que nos da control directo sobre transiciones STRUGGLING→TRYING→RESTORED sin reentrenar nada. Vale la pena leer su fase 02 antes de implementar character sheets propios.

---

## Repositorios relevantes

### 🔴 Aprendizaje directo a backlog

**`vargHQ/sdk` (301, TS, may-2026)** — SDK TypeScript que expone API JSX-React para componer videos (`<Render><Clip><Video><Captions/></Clip></Render>`) con providers Kling/Flux/ElevenLabs/Sora unificados detrás de Vercel AI SDK. Caching por props (mismas props = $0). **Llevarnos:** patrón de API declarativa para reemplazar nuestra orquestación imperativa de bloques; y el caching por hash-de-props es exactamente lo que necesitamos para no re-generar imágenes en re-renders.

**`zhanghaonan777/Seedance2-skill` (70, feb-2026)** — Skill package con un **four-gate creative review** (memorability / surprise / emotional arc / narrative variation) que itera el prompt hasta pasar el gate. Incluye 12 categorías de shot-language (100+ términos) y soporta `--image`, `--last-frame`, `--ref-images`. **Llevarnos:** copiar la estructura de los 4 gates como validador del prompt de image-to-video (oportunidad #3) antes de mandar a Kling/Veo; y robar el reference.md de términos cinematográficos para enriquecer "camera {move}".

**`YouMind-OpenLab/awesome-seedance-2-prompts` (1.2k, TS, may-2026)** — Corpus de 2000+ prompts con estructura confirmada `[STYLE] + [CHARACTER] + [SCENE] + [SHOTS time-coded] + [CAMERA] + [TECHNICAL]` y secuencias time-coded `(0-4s, 4-9s, 9-15s)`. **Llevarnos:** la convención de time-codes para el image-to-video largo y como template para el bloque `narrator-analyzer`. Más rico que nuestra "Three layers".

**`zhouxiaoka/autoclip` (5.4k, Python+React, may-2026)** — Pipeline que extrae highlights de video largo: outline → timeline → **highlight scoring** (jingcaidu) → title gen. Usa Qwen LLM para puntuar segmentos. **Llevarnos:** la fase de *scoring* aplicada a la oportunidad #1 (hook bombardeo). En vez de elegir 5 frames a ojo del video >60s, scorear segmentos con Gemini multimodal y extraer los top-5 picos. El stack es Python pero el algoritmo es portable.

**`Phantom-video/Phantom` (1.5k, sep-2025)** — Subject-consistent video generation con 1-4 reference images (single o multi-subject). **Llevarnos:** confirma que el patrón "multi-ref images → mismo personaje en N escenas" es state-of-the-art viable; lo combinamos con BigBanana para resolver oportunidad #2.

### 🟡 Arquitectura / UX general

**`calesthio/OpenMontage` (3.9k, Python, may-2026)** — Sistema agéntico con **scored provider selection engine** de 7 dimensiones (task-fit, quality, control, reliability, cost, latency, continuity) + 12 pipelines tipificados + checkpointing con decision-log. **Llevarnos:** nuestra cascada de 6 image providers usa un score binario (quota OK / no OK); el scorer de 7 dimensiones es directamente aplicable y nos da racional auditable para "por qué Vertex y no fal en este caso".

**`timoncool/videosos` (1.2k, TS+Next.js+Remotion, may-2026)** — Editor de video AI **100% browser** con Remotion + FFmpeg.wasm + IndexedDB. Integra fal.ai y Runware.ai como meta-providers. **Llevarnos:** la combinación Next.js+Remotion es nuestra propia pila; vale la pena leer su `<Composition>` y su patrón de storage local; pero **no** resuelve consistencia ni hooks.

**`gyoridavid/short-video-maker` (1.1k, TS, jun-2025)** — Remotion + Kokoro TTS + Whisper.cpp + Pexels + MCP server. Pipeline scene-based casi idéntico al nuestro. **Llevarnos:** ejemplo limpio de cómo exponer el generador como MCP server (útil para que Claude Code dispare videos directamente). No tiene image-to-video ni consistency, pero el código Remotion+scene puede ser referencia.

**`SamurAIGPT/Generative-Media-Skills` (3.3k, Shell, may-2026)** — 41 "recipes" markdown para agentes (Cinema Director, Nano-Banana, etc.) sobre `muapi-cli`. **Llevarnos:** la convención de exportar cada modo de Video Factory (Crear/Ripear/Aprender) como un skill markdown empaquetable es replicable; el split core/library es buen patrón.

### 🟢 Nice-to-know

**`PKU-YuanGroup/ConsisID` (844, abr-2026)** — Identity preservation tuning-free con frequency decomposition. Más académico; útil si entrenamos modelos propios.

**`alecm20/story-flicks` (2.4k, Python+React, mar-2025)** — Pipeline story-to-video básico, sin consistency ni image-to-video; solo valida que el patrón script→imagen/segmento es estándar.

**`302ai/302_video_generator` (107, Next.js 14+TS, ago-2025)** — UI shadcn/Zustand para video gen; no Remotion. UX inspiration mínima.

---

## Top 3 takeaways accionables

1. **Implementar character sheets ya (oportunidad #2)**: leer fase 02 de BigBanana + adoptar el patrón `multi-ref images → Phantom-style consistency`. Empezar con Nano Banana + condicionado por 3 ref-images del mismo personaje.
2. **Reemplazar la cascada binaria de providers por scorer 7-D al estilo OpenMontage**: ya tenemos quota-detection + Bottleneck; agregar dimensiones cost/latency/continuity al ranking nos da decisiones auditables.
3. **Two-pass prompting para image-to-video (oportunidad #3)**: stackear el corpus de `awesome-seedance-2-prompts` (estructura `[STYLE][CHARACTER][SHOTS time-coded][CAMERA]`) con los 4-gates de `Seedance2-skill` como validador. Reemplaza nuestra "Three layers" actual por algo testeable.
