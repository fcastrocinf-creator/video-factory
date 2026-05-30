# Investigación profunda: patrones e ideas (SaaS + OSS + papers)

> Complemento de `13-github-video-generator-topic.md`. No repite hallazgos previos (BigBanana, OpenMontage, vargHQ, Phantom, Seedance2-skill, awesome-seedance, autoclip, short-video-maker, etc.). Foco en **patrones conceptuales** absorbibles para Video Factory, no en herramientas a clonar.

---

## Hallazgos destacados

### 🔥 Hallazgo crítico — "Timeline prompting" desbanca a la cascada de prompts por escena

Para image-to-video, la práctica dominante 2025-2026 dejó de ser "un prompt por shot" y pasó a ser **un solo prompt time-coded** que el modelo (Seedance 2.0, Veo 3.1, Sora 2) descompone internamente. La estructura ganadora es:

```
[Global setup: shot, subject, environment, lighting, style]
[0:00-0:03] Shot type. Action. One detail.
[0:03-0:07] Shot type. Development. One detail.
[0:07-0:10] Shot type. Resolution. Mood word.
```

Esto preserva consistencia de personaje **sin** character sheet porque el modelo razona sobre la secuencia entera. Para Video Factory implica: el bloque `scene-animator-kling` debería tener dos modos — *segmentado* (uno por uno, lo actual) y *timeline* (un prompt para clips ≤10s con time-codes). Diferencia esperada: menos drift entre shots cortos de un mismo "beat narrativo" y reducción de costo (1 llamada vs N).

### ⚠️ Competidor directo identificado — Topview AI

Topview es lo más cercano a Video Factory que existe en SaaS público. **Lo hace bien:** analiza un ad de referencia (escenas, hooks, pacing, shot structure, transiciones, tono musical) y lo recrea con tu producto. Tiene un AI Scriptwriter entrenado sobre estructura "Hook-Value-CTA" y un corpus de 500M videos para taxonomía de hooks. Cobra por seat, no abre nada del pipeline.

**Lo que le falta (y nosotros podemos ganar):**
- No tiene modo "Aprender" — los presets son cerrados, no destila estilo en plantilla reutilizable.
- Pipeline opaco: no se puede inspeccionar/editar la decisión escena por escena.
- No tiene multi-provider con fallback (lockeado a Sora 2 y modelo propio).
- Sin character sheet multi-estado.

**Lo que copiar:** la taxonomía de hooks entrenada sobre N videos virales; el "reference video" como input de primer orden (no como string sino como objeto multimodal); y el AI Scriptwriter como bloque dedicado antes de scene-planner.

[Topview AI](https://www.topview.ai/)

### ⚠️ Competidor secundario — Vibemyad / Creatify

Más enfocados en avatares UGC AI que en B-roll/VSL. Su feature notable es **pre-launch performance prediction (CTR/ROAS)** vía 150k+ agentes consumer simulados. Conceptualmente: antes de mandar el video al render final, lo evalúan contra un panel sintético. Aplicable a Video Factory como *gate* de "preview" antes del render Remotion (más adelante en sección C).

[Vibemyad blog](https://www.vibemyad.com/blog/best-ai-ad-generator-for-d2c-brands-on-meta-in-2026-how-to-generate-high-converting-creatives), [Creatify](https://creatify.ai/features/ai-scriptwriter)

---

## A. Prompt engineering avanzado para script→video

### Patrón A1: "Middle layer" / plot summary intermedio

Estudios académicos de co-escritura de guiones (Mirowski et al., ACM CHI 2025) demuestran que **insertar una capa abstracta de "plot beats" entre el script crudo y la generación de escenas** mejora drásticamente la coherencia de largo aliento. La capa no genera prompts; genera un resumen estructurado: `act → goal → emotion-shift → action`.

**Aplicación a Video Factory:** el bloque `narrator-analyzer` actual produce texto plano. Sumar una sub-fase `beat-extractor` que devuelva un objeto `{ beats: [{ phase, goal, emotionDelta, suggestedShot }] }`. Ese objeto alimenta scene-planner. Beneficio: validable (¿el video tiene un emotion arc o es plano?), reusable (mismo beat-array puede mapearse a B-roll Pixar o a UGC).

[Co-Writing Screenplays — ACM CHI](https://dl.acm.org/doi/fullHtml/10.1145/3544548.3581225)

### Patrón A2: RAG con corpus de cinematografía real

FilMaster (arXiv 2506.18899) introduce **Multi-shot Synergized RAG**: para decidir qué shot type usar en cada beat, el LLM no inventa sino que **recupera** descripciones cinematográficas de un corpus de 440k clips de cine. Mapea similitud semántica entre el beat actual y descripciones reales para sugerir "close-up handheld" vs "static wide" con autoridad de gramática cinematográfica.

**Aplicación a Video Factory:** mantener un mini-corpus (200-500) de descripciones shot-by-shot de ads ganadores ya scrapeados en /ripear pasados. Cuando scene-planner decida shots, consulta este índice por similitud semántica del beat ("usuario abre paquete con curiosidad" → recupera 3 ejemplos similares, lee qué shot eligieron, propone variantes). Esto convierte el modo Aprender en aprendizaje de segundo orden (no solo presets, sino corpus de decisiones de dirección).

[FilMaster arXiv](https://arxiv.org/abs/2506.18899)

### Patrón A3: Creative direction como decisión separada de la generación

Los SaaS serios separan **dos roles de LLM**: el "Director" (decide tipo de shot, cuándo cortar, qué emoción enfatizar) y el "Cinematographer" (escribe el prompt visual concreto). Pasarlos como una sola llamada produce decisiones blandas. Como dos llamadas con roles explícitos, la calidad sube y son auditables por separado.

**Aplicación:** en `scene-planner`, separar `direct()` y `prompt()`. `direct()` devuelve `{ shotType, lens, mood, cutReason }`; `prompt()` recibe ese objeto y produce el string para Kling/Veo. Beneficio: el log queda "Director eligió close-up porque cutReason=emotional-peak" — el día que falla algo, sabés cuál de los dos roles falló.

### Patrón A4: Hierarchical few-shot por categoría

En vez de un único set de few-shots, mantener **hierarchical few-shot pools**: nivel-1 por formato (B-roll Pixar vs UGC vs VSL), nivel-2 por beat (hook vs mechanism vs CTA). El planner elige 2-3 ejemplos del pool correcto según contexto. Mantiene la prompt corta y específica.

---

## B. Multi-shot consistency más allá de character sheet

### Patrón B1: Anchor frame + extension

**Práctica dominante 2025-2026 (Veo 3.1, Kling 3, Sora 2):** generar el shot N "to a clean last frame", y usar ese frame como first-frame del shot N+1. Preserva motion vectors, orientación del sujeto, iluminación. Mejor que reference-image porque el modelo arranca con continuidad temporal, no solo visual.

**Aplicación:** nuestro `scene-animator-kling` ya tiene `useKlingEndFrame: false` en el preset Pixar (porque el especialista decidió que no). Agregar modo opcional `anchorChain: true` que use end-frame de shot N como start-frame de shot N+1 cuando dos shots son del mismo "beat". El scene-planner ya tiene phase tagging (hook/mechanism/resolution/cta) — usar shots dentro de la misma phase como cadena. [Sora 2 vs Veo 3 vs Runway Gen-4](https://reezo.ai/blog/sora-2-vs-veo-3-vs-runway-gen-4-comparison-2025)

### Patrón B2: "Ingredients to video" — N reference images simultáneas

Veo 3.1 acepta hasta 4 reference images por generación. El modelo aprende composicionalmente: ref1=personaje, ref2=producto, ref3=ambiente, ref4=estilo. Más rico que character sheet único.

**Aplicación:** ampliar el schema de brand para tener `ingredients: { character[], product[], environment[], styleReferences[] }` y que `scene-animator` arme combinaciones según el shot. Por ejemplo: en un close-up de mano agarrando el producto, mandar (product + character.hands + environment.light). [Veo 3.1 Multi-Prompt](https://skywork.ai/blog/multi-prompt-multi-shot-consistency-veo-3-1-best-practices/)

### Patrón B3: Scene context buffer (de SceneDecorator, NeurIPS 2025)

SceneDecorator implementa **scene-sharing attention** con un buffer que persiste features visuales dominantes (paleta, arreglo espacial, atmósfera) entre shots. No requiere re-entrenar el modelo — es training-free. La idea portable es: extraer post-generación los colores dominantes + saturación + luminosidad de cada shot, y para el siguiente shot **inyectar esos valores en el prompt** ("matching the previous shot's amber-and-gold palette and soft warm light").

**Aplicación:** post-cada-imagen, correr un pequeño analyzer (Sharp + extract palette top-3 colors + un Gemini Vision rápido para "describe atmosphere in 6 words"). Guardar en `scene.visualSignature`. El siguiente prompt inyecta el signature anterior como prefix. Costo bajo, ganancia de consistencia alta.

[SceneDecorator paper](https://arxiv.org/abs/2510.22994)

### Patrón B4: Storyboard-anchored generation (STAGE, arXiv 2512.12372)

STAGE genera **primero start-end frame pairs para cada shot** (storyboard estructural), después los videos. Esto pre-calcula la consistencia espacial antes del costo del video.

**Aplicación a Video Factory:** dos pases. Pase 1: image-gen genera start+end frame por shot (Nano Banana, barato). Pase 2: scene-animator-kling toma esos pares e interpola video. Es exactamente el patrón BigBanana ya identificado en el reporte 13 pero con un giro: aquí la decisión de cuál es end-frame no la toma el director sino el storyboard global, mirando los end-frames de TODOS los shots simultáneamente para minimizar saltos.

---

## C. Validación y quality gates antes de costo

### Patrón C1: VLM judge antes del render final

Self-Improving VLM Judges (arXiv 2512.05145) muestran que un VLM puede ser entrenado iterativamente como juez de calidad con accuracy 0.51 sobre VL-RewardBench, superando modelos mucho más grandes en tareas específicas. Para Video Factory el costo es alto si esperamos al render Remotion para descubrir que la composición visual es mala.

**Aplicación concreta:** insertar un bloque `preview-judge` entre `image-gen-multi` y `scene-animator-kling`. El judge recibe (image, prompt, brand-spec) y devuelve `{ scoreVisual: 0-100, scoreBrandFit: 0-100, scoreHookStrength: 0-100, issues: [], suggestions: [] }`. Si score < threshold, re-generar con suggestions inyectadas. Threshold sugerido 70 (no 90: el judge tiene bias). [Self-Improving VLM Judges](https://arxiv.org/pdf/2512.05145)

### Patrón C2: LAION-Aesthetics como filtro barato

LAION-Aesthetics predictor es un MLP sobre CLIP embeddings que predice "qué tan estética es esta imagen" en escala 1-10. Es **gratis** (modelo ya entrenado, ~50ms de inferencia). Usado como pre-filtro en datasets de Stable Diffusion y curation pipelines.

**Aplicación:** al generar 1 imagen por escena con `image-gen-multi`, correr LAION-Aesthetics. Si score < 5.5, re-roll automático (sin gastar otra llamada al provider — el "re-roll" puede ser un seed diferente de la cascada). Para ads se ha visto que score 6.5+ correlaciona con mejor performance. [LAION-Aesthetics](https://laion.ai/blog/laion-aesthetics/)

### Patrón C3: 4-gate validation iterativa (paralelo conceptual a Seedance2-skill ya identificado)

Concepto adicional al reporte 13: los gates **deben ser pairwise comparativos, no pointwise absolutos** — porque LLMs como juez tienen 50%+ bias en evaluación absoluta pero son más consistentes en comparativa. En vez de "esta imagen ¿es buena?" preguntar "entre A y B ¿cuál es mejor para el hook?". Aggregando con permutación balanceada para neutralizar position bias. [LLM-as-Judge Bias](https://www.adaline.ai/blog/llm-as-a-judge-reliability-bias)

**Aplicación:** generar 3 variantes baratas (SDXL Lightning, 8 steps, ~1s c/u), comparar pairwise (3 comparaciones: A-B, B-C, A-C), elegir winner por Condorcet. Render alto solo del winner.

### Patrón C4: Pre-launch consumer simulation (de Vibemyad)

Ejecutar el preview del ad contra un panel sintético: prompts a Gemini/GPT-4V "actuá como una mujer de 35 años en Mexico, te aparece este ad mientras scrolleas TikTok, ¿qué pensás en los primeros 2 segundos?". Agregar 5-10 panelistas sintéticos diversos. No reemplaza testing real pero filtra los obviamente malos.

---

## D. Cost optimization patterns

### Patrón D1: Two-layer cache (exact-match → semantic)

Best practice 2026: **capa 1** = SHA256 hash de `{prompt, model, params, seed}` en SQL/Redis. **Capa 2** = embedding-based semantic cache (Pinecone/Weaviate) con threshold de similitud coseno ≥ 0.95 para hit. Hit-rate en producción típico: 40-60% capa 1, +15-25% capa 2. Cost reduction 70-90% en flows iterativos.

**Aplicación:** Drizzle ya está. Tabla `prompt_cache (hash, providerId, model, paramsJson, resultUrl, createdAt)` con índice por hash. Capa 2 puede ser nano-Banana ya que tenemos embeddings de Vertex disponibles. Empezar por capa 1 — los re-renders de la misma escena al cambiar TTS van a hitear inmediatamente. [Layered Caching Strategy](https://medium.com/@waliava123/caching-techniques-for-llm-applications-part-1-exact-match-semantic-caching-b17fb0e2bbff)

### Patrón D2: Tier strategy "draft → promote"

SDXL Lightning genera en 4 steps (~0.5s en GPU) con quality gap mínima vs SDXL base (50 steps). Flux Schnell mismo. **Patrón:** todas las generaciones empiezan en draft (Schnell/Lightning, ~$0.001/img); usuario aprueba; segundo pase con Imagen 3 / Vertex (premium, ~$0.04/img) **solo del aprobado**.

**Aplicación:** nuestro `image-gen-multi` ya tiene cascada de 6. Agregar una dimensión: `tier: 'draft' | 'premium'`. UI por defecto draft, botón "promote to premium" en el editor. Para Aprendizaje (que itera mucho) usar draft hasta convergencia, premium solo del final. Ahorro estimado: 60-80% en runs de Aprender. [Flux vs SDXL](https://www.multic.com/guides/flux-vs-sdxl/)

### Patrón D3: Hedging — race providers, take first

Para latencia P99 baja: lanzar la misma request a 2 providers en paralelo, cancelar el que responda segundo. Aumenta costo ~1.8x pero baja P99 ~3-5x. Útil para flows interactivos (editor, preview) donde latencia mata UX.

**Aplicación:** modo `urgent: true` en `image-gen-multi`. Si está activo (ej. usuario en /editor regenerando 1 escena) corre Vertex + fal en paralelo, toma el primero. Modo normal (batch en /create) sigue serial cascada. [LLM Latency optimization](https://medium.com/athina-ai/solving-latency-challenges-in-llm-deployment-for-faster-smarter-responses-64ff301e40d3)

### Patrón D4: Batch async para Aprendizaje

AWS Bedrock / Together AI / Alibaba Cloud ofrecen 50% descuento en modo batch async (vs sync online). Latencia: minutos a horas en vez de segundos. Para el modo Aprendizaje donde el usuario sube un video y va a tomar un café mientras se procesa, el batch async es perfecto.

**Aplicación:** `style-trainer.ts` itera 5 veces por keyframe — 25-50 llamadas a Gemini Vision. Submit todas como batch job; poll cada 30s. Costo -50%. [AWS Bedrock Batch](https://aws.amazon.com/blogs/database/optimize-llm-response-costs-and-latency-with-effective-caching/)

---

## E. UX / workflow patterns

### Patrón E1: "Specify, regenerate locally" en vez de "regenerar todo"

Investigación reciente (SpecifyUI, arXiv 2509.07334) muestra que para UI generation, usuarios prefieren editar specs estructuradas a regenerar todo desde prompt. Localizan ediciones, preservan layout circundante. Mismo principio para video.

**Aplicación a Video Factory:** en `/runs/[id]/editor`, cada escena debe exponer su "spec" (prompt + parámetros + seed + reference images). El usuario edita la spec, no el prompt suelto. Botón "regenerate this scene" toca solo esa, conserva consistency buffer (patrón B3). Esto es lo que ya pensaba el owner como "re-render parcial" pero formalizado: edit-spec > prompt-edit. [SpecifyUI paper](https://arxiv.org/html/2509.07334v1)

### Patrón E2: Branch and pick (variants tree)

UI common en Midjourney, Krea, Runway: cada generación produce 4 variantes, el usuario pickea una, esa se vuelve "current", y opcionalmente puede branchear más variantes desde ahí. Visualmente es un árbol.

**Aplicación:** botón "3 variants" en cada escena que crea ramas. La rama "main" es la que va al render final. Las otras quedan visibles pero ignored. Permite explorar sin comprometer. Storage cheap si las variantes son draft-tier (D2).

### Patrón E3: Phase-tagged timeline navegable

Ya tenés el phase tagging del scene-plan (hook|mechanism|resolution|cta — sugerencia previa). El siguiente paso UX: la timeline del editor debe estar **coloreada por fase** y permitir "salto al hook", "salto al CTA". Submagic y Opus Clip lo hacen y simplifica enormemente la iteración cuando el usuario sabe "el problema está en el hook".

### Patrón E4: Inline diff de prompt edits

Cuando el usuario edita la spec de una escena, mostrar diff (color) entre el prompt original y el editado, y al re-generar mostrar diff visual lado a lado (antes / después / diferencias). Patrón estándar en Replicate y Krea. Reduce el "no sé qué cambió" feeling.

---

## F. Audio / TTS / sync patterns

### Patrón F1: Phoneme-level forced alignment (WhisperX)

WhisperX (m-bain/whisperX en GitHub) hace forced alignment con Wav2Vec2 y entrega timestamps **a nivel phoneme** sub-100ms. Mucho más fino que word-level que ya usamos.

**Aplicación:** los cuts de escena pueden alinearse a phoneme boundaries específicos. "El producto" → cortar en /e/ del "El" para que la imagen del producto aparezca exactamente al phoneme. Esto se percibe como cinema, no como video AI. WhisperX es Python; podemos exponerlo como microservicio o portar lógica de alignment ya que el modelo Wav2Vec2 existe en ONNX. [WhisperX repo](https://github.com/m-bain/whisperX)

### Patrón F2: Auto music ducking durante voz

Detección de speech activity → reducir volumen de música -8 a -12 dB durante speech, fade-out 200ms. AI auto-duck tiene ~95% accuracy en detección. Manual es horas; AI segundos.

**Aplicación:** en `compositor-remotion`, si hay música de fondo + TTS, aplicar ducking automático usando los timestamps word-level que ya tenemos. Trivial de implementar con audio filtros de Remotion. [AI Auto Duck](https://reelmind.ai/blog/ai-video-auto-duck-lower-background-music-for-dialogue)

### Patrón F3: Pitch/velocity emphasis por palabra clave

ElevenLabs y otros TTS soportan SSML con `<emphasis>` y `<prosody rate="+10%" pitch="+2st">`. El planner debe identificar las "power words" del script (verbos de acción, números, brand name, CTAs) e inyectar los tags automáticamente.

**Aplicación:** un mini-LLM step "annotate this script with SSML emphasis tags" antes de mandar a TTS. Costo despreciable, ganancia en performance audible. Power words típicos D2C: brand name, número del producto, "gratis", "ahora", "garantía", verbos del CTA.

### Patrón F4: Lip-sync barato con Wav2Lip (no Tavus)

Tavus / Arcads / HeyGen son SaaS caras para lip-sync. Wav2Lip es OSS, corre en CPU/GPU, gratis. No es state-of-art pero suficiente para UGC pseudo-real donde no se mira la boca de cerca. Para Video Factory en formato UGC con "talking head" de stock + voz clonada, Wav2Lip puede entregar 80% del valor a 0% del costo.

---

## G. Subtitle / typography automation

### Patrón G1: Composition-aware placement (cap NO sobre cara)

Investigación 2025-2026 usa VLMs para identificar regiones "must-avoid" (cara, producto, logo) vs "OK-overlay" (cielo, pared lisa) y posicionar el subtítulo en zonas seguras. Saliency maps por sí solos no distinguen "evitar" de "puede tapar".

**Aplicación:** post-imagen, correr Gemini Vision con prompt corto "return bounding box of face, product, logo in this image". Pasar a Remotion como `safeZones`. Layout engine de subtítulos evita esas zonas. [Content-Aware Layout](https://arxiv.org/pdf/2512.12596)

### Patrón G2: Emoji insertion contextual no chocante

Patrón Submagic: insertar emoji **al final de la palabra clave**, no random. Algoritmo simple: para cada N palabras, si la palabra tiene match con vocabulario emoji-friendly (verbos físicos, sustantivos concretos, emociones), insertar emoji apropiado. Skip si último emoji fue hace <2s.

**Aplicación:** ya hay sub-formato "kinetic word-level"; sumar `emojiDensity: low|med|high` y el algoritmo de inserción. Para Vitaly (suplementos) cuidado con emoji médicos (cápsula, mancuerna, etc. pueden activar policy violations).

### Patrón G3: A/B test de estilos de subtítulo con métricas

Data de A/B tests: motion variant gana 15-25% lift vs estático. Kinetic word-by-word con bounce wins vs slide. Color shift en power words wins vs monocolor.

**Aplicación:** loggear qué estilo de subtítulo usó cada run y, cuando tengamos data de performance (ver J), correlar. Por ahora hardcodear top-3 estilos conocidos por sub-formato y rotar. [Kinetic Typography retention](https://www.ikagency.com/graphic-design-typography/kinetic-typography/)

### Patrón G4: Tipografía como signal emocional

Característica negada en el reporte 13: la fuente comunica. Sans bold = autoridad/grita. Serif = trust/premium. Display script = lifestyle/aspiracional. El planner debe escoger fuente por phase (hook = bold display; mechanism = clean sans; CTA = bold colored).

---

## H. Brand consistency / template enforcement

### Patrón H1: Brand como data source queryable (Frontify pattern)

Frontify trata brand guidelines como API consultable, no como PDF. AI puede preguntar "¿cuál es el primary color?" y obtener respuesta estructurada. Permite enforcement automático.

**Aplicación:** `packages/brands/{brand}.ts` ya tiene tokens. Formalizarlo como **brand schema queryable**: cada bloque del pipeline tiene acceso a `brand.query('primaryColor')`, `brand.query('voiceTone')`, etc. Validador final corre `brand.audit(generatedVideo)` que detecta violaciones (logo fuera de safe zone, color fuera de paleta, fuente no aprobada). [Frontify AI Brand Assistant](https://www.frontify.com/en/ai)

### Patrón H2: Locked elements vs flexible elements

Patrón concreto del especialista Pixar (ya identificado) generalizado: cada brand define `locked = [logo position, CTA color, end-card layout]` y `flexible = [composition, character poses, environment]`. El compositor enforce locked y deja libre flexible.

### Patrón H3: Auto-detect violaciones con VLM

Post-render, correr un VLM check: "in this video frame, is the logo present? is it in the bottom-right corner? is its color #FF6B35? is the CTA button green?". Si NO → flag y suggest fix. Es la versión productizada del "auto-detect violaciones" mencionado en sección original.

### Patrón H4: Named entities con asset binding

Ya identificado: 5 moléculas con 5 colores. Extender a un schema `brand.namedEntities = { 'zinc': { color: '#C0C0C0', visualRef: 'assets/zinc.png', voice: 'el mineral guardian' } }`. El planner consulta esto cuando detecta la palabra en el script y auto-inyecta el visual ref + color.

---

## I. Storytelling / narrative structure patterns

### Patrón I1: AIDA mapeado a timeline

Hook-Problem-Solution-CTA es la versión adaptada para video ad. Cada uno debe tener un timing target:
- Hook: 0-3s (decide retention)
- Problem: 3-8s
- Solution/Mechanism: 8-18s
- CTA: 18-30s (o final si VSL)

Si el script no cumple, el script-processor debe **reescribir** (no rechazar) para forzar la estructura. Modelo prompt: "Reescribe este script para que el hook sea ≤3s, problema ≤8s, etc."

**Aplicación:** nuevo bloque `script-validator` antes de narrator-analyzer. Detecta phases por keywords + estimación de tiempo de TTS. Si malformado, reescribe. Logs el original para auditoría. [AIDA TikTok](https://www.foreplay.co/post/aida-copywriting-tiktok-ad), [VSL structure](https://thrivethemes.com/video-sales-letter-script/)

### Patrón I2: Emotional arc detection con curve

Cada beat tiene un valor de emoción (-1 a +1). El video ideal tiene curva: 0 → -0.5 (problema dolor) → -0.7 (peak dolor) → +0.3 (mechanism reveal) → +0.8 (solution joy) → +0.6 (CTA satisfacción). Curva plana = malo. Subir y bajar = bueno.

**Aplicación:** bloque `emotion-arc-checker` post script-validator. Gemini puntúa cada beat emocionalmente. Si la curva es plana (varianza < 0.3), flag y sugerir reescritura. Útil especialmente para VSL largos donde la atención decae.

### Patrón I3: Hook taxonomy por tipo

7 formulas conocidas que dan retention 70%+:
1. **Bold claim** ("Perdí 12 kilos en 30 días sin dieta")
2. **Question hook** ("¿Sabías que el 80% de los suplementos no se absorben?")
3. **Negative hook** ("NO compres este producto si...")
4. **Curiosity gap** ("Esto es lo que pasa cuando...")
5. **Pattern interrupt** (acción visual extraña + texto)
6. **Story open** ("Hace 3 meses estaba destruido")
7. **Stat shock** ("99% de los gym-rats hacen esto mal")

**Aplicación:** brand schema tiene `hookPreferences: ['bold-claim', 'story-open']`. Script-processor elige hook type según producto + preferences. Si el hook generado no calza ningún tipo conocido, flag. [Hook Formulas](https://www.opus.pro/blog/tiktok-hook-formulas)

### Patrón I4: VSL mechanism-story formula

Para VSL largos (>60s), el "mechanism" es el corazón. Patrón Rob Palmer (specializado en supplements): introducir Problem Mechanism (root cause real) + Solution Mechanism (antídoto). Diferencia clave vs ad corto: el VSL explica POR QUÉ otros productos fallaron. Construye trust.

**Aplicación:** sub-formato VSL en preset, con `requiresMechanism: true`. Script-validator chequea que el script incluya esta sección, sino sugiere agregarla. Para Vitaly (suplementos) es crítico — sin mechanism, son solo claims.

---

## J. Data flywheel / aprendizaje continuo

### Patrón J1: Performance data → preset weights

Tras 30-90 días de un preset en producción con ads reales corriendo, se debería tener: retention curve, CTR, ROAS, frecuencia de scroll-stop. Esos datos deberían **alimentar el preset** retroactivamente: si los videos con phase=hook con shot-type=close-up retienen +15% que wide, el preset actualiza su default shotType para hook.

**Aplicación:** schema `presetPerformance: { version, hookRetention3s, ctr, recommendedShots: { phase: shotType } }`. La data viene del Meta Ads Manager (manual o API). Un cron mensual recalcula presets.

### Patrón J2: User feedback como signal

Cada vez que el owner regenera una escena, eso es señal de "no me gustó". Cada vez que la deja, es "OK". Cada vez que la promueve a hero/save-favorite, es "winner".

**Aplicación:** tabla `scene_feedback (sceneId, action: 'kept'|'regenerated'|'favorited', timestamp)`. Después de N=50 entradas, correr un mini-análisis: "qué prompts tendían a ser regenerados", "qué shotTypes tendían a ser favorited". Sugiere ajustes al preset. No automático — sugerencia a `storage/sugerencias/`.

### Patrón J3: Cohort patterns

"Tus videos con producto Vitaly Zinc tienden a ganar con hook=stat-shock". "Tus videos con Nelo y formato UGC ganan más a la mañana". Análisis sobre runs históricos.

**Aplicación:** dashboard `/admin/insights` que agregue por brand × product × hookType × shotType. SQL trivial sobre Drizzle. Útil para decisiones de scaling.

### Patrón J4: Auto-suggestion al crear

UX: cuando el usuario va a `/create` y selecciona brand=Vitaly + product=Zinc, mostrar "Para este combo, tus videos con preset Pixar B-roll + hook stat-shock tuvieron CTR promedio +35%". Reduce decision fatigue.

[Data Flywheels](https://www.alexsmale.com/data-flywheels-usage-product-intelligence/)

---

## K. Localización / multi-idioma

### Patrón K1: ElevenLabs voices con "tone neutro Latam"

ElevenLabs tiene voces específicamente etiquetadas "neutral accent" (ej. Andres Felipe, Jhony v2 según search). Para español neutro Latam, evitar voces marcadas "argentine", "mexicano", "colombiano" salvo intencional.

**Aplicación:** `brand.voice = { provider: 'elevenlabs', voiceId, neutralityScore: 0-10 }`. Marca con neutralityScore ≥8 son seguras para Latam. Curate una lista de voiceIds aprobadas. [ElevenLabs Latin American](https://elevenlabs.io/text-to-speech/latin-american-accent)

### Patrón K2: "Translate intent, not words"

Modismos pierden punch en traducción directa. Ej. "killer offer" en EN → "oferta asesina" suena raro en ES. Mejor "oferta que arrasa". Patrón: el LLM debe traducir **adaptando**, no literalmente. Prompt: "Reescribe este copy de ad en español neutro Latam manteniendo el punch emocional, evitando modismos regionales y argentinismos".

**Aplicación:** si se introduce multi-idioma (no urgente pero llegará), agregar bloque `localization` con preset por target locale.

### Patrón K3: Forbidden claims list por mercado

Vitaly (suplementos) tiene claims que en US violan FTC/FDA, en MX violan COFEPRIS, en ES violan EFSA. Cada uno con su propio diccionario. La detección es regex + LLM check.

**Aplicación:** `brand.complianceRules = { 'mx-cofepris': ['cura', 'previene', 'tratamiento médico'], 'us-fda': ['treat', 'cure', 'prevent disease'] }`. Validator final escanea el script + subtítulos + audio transcript. Hard-fail si match.

---

## L. Observability / pipeline debugging

### Patrón L1: OpenTelemetry para prompts (Langfuse + Phoenix)

Stack 2026 de elección: **Langfuse** (operational telemetry: token costs, latency, prompts, request tracing — MIT-licensed, self-hostable) **+ Phoenix Arize** (RAG observability, faithfulness, hallucination detection, eval). Ambos soportan OpenInference / OpenTelemetry.

**Aplicación:** instrumentar el pipeline con Langfuse SDK. Cada bloque emite span con `{prompt, model, params, output, cost, latency}`. Trace completo de un run en UI navegable. Self-host con Docker, datos quedan en el dev local. [Langfuse vs Phoenix](https://www.spheron.network/blog/llm-observability-gpu-cloud-langfuse-arize-phoenix-helicone/)

### Patrón L2: Decision-log con racional

Cada decisión "automática" del LLM debe loggear el racional. Ej: "Director eligió close-up porque emotion=peak=+0.8 y beat=mechanism-reveal y few-shot example #3 mostraba close-up para mismo patrón. Cost=$0.002. Latency=320ms". Texto plano, append-only, JSONL.

**Aplicación:** en `apps/web/lib/`, agregar `decision-logger.ts` que cada bloque consulta. Output a `storage/decisions/{runId}.jsonl`. Cuando algo falla, abrir ese archivo es el primer paso.

### Patrón L3: Deterministic replay

Cada run loggea seeds, model versions, params completos. Para reproducir un bug: `replay <runId>` reconstruye exactamente la misma sequence. Esencial cuando el bug se manifiesta en 1/30 runs.

**Aplicación:** la tabla `runs` ya existe. Agregar columnas `seedsJson`, `modelVersionsJson`. Script `pnpm replay <runId>` levanta el run con los seeds originales. [Deterministic Replay](https://tianpan.co/blog/2026-04-12-deterministic-replay-debugging-non-deterministic-ai-agents)

### Patrón L4: Provider failure dashboard

Métrica simple: `provider × failureRate × failureReason × timestamp`. Sirve para decidir cuándo deprecar un provider o renegociar quota. La cascada actual ya loggea fails — solo falta el dashboard.

---

## Top 10 ideas accionables por impacto/esfuerzo

| # | Idea | Impacto | Esfuerzo | Tag |
|---|---|---|---|---|
| 1 | **Two-layer cache (hash + semantic)** en `image-gen-multi` | Alto (-70% costo en re-renders) | Bajo (Drizzle + Redis ya disponibles) | 🚀 |
| 2 | **Timeline prompting** para image-to-video time-coded ≤10s | Alto (mejor consistency, -50% calls a Kling) | Bajo (modificar prompt template del scene-animator) | 🚀 |
| 3 | **LAION-Aesthetics pre-filter** en image-gen para auto-reroll | Alto (filtra basura sin gasto humano) | Bajo (modelo gratis, ~50ms) | 🚀 |
| 4 | **Phase-tagged timeline UI** en /runs/[id]/editor + colorcoding | Alto (UX para iteración) | Bajo (phase tagging ya viene de sugerencia previa) | 🚀 |
| 5 | **Decision-logger** JSONL append-only en bloques | Alto (debug + auditoría) | Bajo (utility class trivial) | 🚀 |
| 6 | **Two-pass tier strategy** (draft Schnell → premium Imagen) con botón promote | Alto (-60-80% costo Aprender) | Medio (UI + cascade aware de tier) | ⚙️ |
| 7 | **VLM judge** entre image-gen y scene-animator (preview-judge bloque) | Alto (catches errores antes del costo de video) | Medio (nuevo bloque, threshold tuning) | ⚙️ |
| 8 | **Scene context buffer** (palette + atmosphere extraction post-imagen) | Alto (consistency real entre shots sin character sheet) | Medio (Sharp + Gemini Vision rápido) | ⚙️ |
| 9 | **Langfuse self-hosted** + instrumentación de pipeline | Medio (essential cuando pipeline crece) | Medio (Docker compose + SDK wrappers) | ⚙️ |
| 10 | **Hedging racing** modo `urgent` en cascada image-gen | Medio (UX en editor) | Bajo (Bottleneck ya está) | 🚀 |

**Para explorar (no urgente):**
- 💡 RAG corpus de cinematografía (FilMaster pattern) — requiere construir corpus.
- 💡 Performance data flywheel (J1-J4) — requiere data de Meta Ads, no urgente hasta tener volumen.
- 💡 WhisperX phoneme-level cuts — gana mucho audio, requiere microservicio Python.

**Descartar por ahora:**
- 🗑️ Pre-launch consumer simulation con panelistas sintéticos — más teatro que valor real. Mejor invertir en VLM judge (#7).
- 🗑️ Tavus/Wav2Lip para lip-sync — Video Factory no apunta a UGC con avatar por ahora; cuando sí, evaluar.
- 🗑️ STAGE training-free implementación completa — demasiado complejo vs ganancia incremental sobre BigBanana ya identificado.

---

## Cierre

Las dos ideas más disruptivas: **timeline prompting** (cambia cómo pensamos el prompt para image-to-video) y **scene context buffer** (resuelve consistency sin character sheet ni re-entrenamiento). Ambas son cambios conceptuales pequeños con impacto grande.

El competidor Topview es la referencia comercial a vigilar — su feature "reference video → recreate" es exactamente el modo Ripear. Si Topview agrega "destilar preset" (modo Aprender), nos quedamos sin diferenciador. Hay que moverse rápido en J (data flywheel) que es donde tenemos ventaja estructural por ser dueños de los datos del owner.

## Fuentes consultadas

- [FilMaster — Bridging Cinematic Principles and Generative AI](https://arxiv.org/abs/2506.18899)
- [SceneDecorator — NeurIPS 2025](https://arxiv.org/abs/2510.22994)
- [STAGE — Storyboard-Anchored Generation arXiv 2512.12372](https://arxiv.org/html/2512.12372v2)
- [Self-Improving VLM Judges arXiv 2512.05145](https://arxiv.org/pdf/2512.05145)
- [LLM-as-Judge Bias and Reliability — Adaline](https://www.adaline.ai/blog/llm-as-a-judge-reliability-bias)
- [Timeline Prompting Seedance 2.0](https://www.mindstudio.ai/blog/timeline-prompting-seedance-2-cinematic-ai-video)
- [Veo 3.1 Multi-Prompt Storytelling](https://skywork.ai/blog/multi-prompt-multi-shot-consistency-veo-3-1-best-practices/)
- [Co-Writing Screenplays with LLMs — ACM CHI](https://dl.acm.org/doi/fullHtml/10.1145/3544548.3581225)
- [Topview AI](https://www.topview.ai/) (competidor directo)
- [Vibemyad AI Ad Generator](https://www.vibemyad.com/blog/best-ai-ad-generator-for-d2c-brands-on-meta-in-2026-how-to-generate-high-converting-creatives)
- [Creatify AI Scriptwriter](https://creatify.ai/features/ai-scriptwriter)
- [Layered Caching Strategy](https://medium.com/@waliava123/caching-techniques-for-llm-applications-part-1-exact-match-semantic-caching-b17fb0e2bbff)
- [LAION-Aesthetics Predictor](https://laion.ai/blog/laion-aesthetics/)
- [WhisperX repo m-bain](https://github.com/m-bain/whisperX)
- [Langfuse / Phoenix / Helicone comparison](https://www.spheron.network/blog/llm-observability-gpu-cloud-langfuse-arize-phoenix-helicone/)
- [Deterministic Replay for LLM Agents](https://tianpan.co/blog/2026-04-12-deterministic-replay-debugging-non-deterministic-ai-agents)
- [AIDA TikTok framework](https://www.foreplay.co/post/aida-copywriting-tiktok-ad)
- [VSL Mechanism-Story Formula — Rob Palmer](https://robpalmer.com/blog/supplement-vsl-copywriting)
- [Hook formulas 70%+ retention](https://www.opus.pro/blog/tiktok-hook-formulas)
- [TikTok Pattern Interrupts](https://inceptly.com/simple-video-tricks-that-stop-the-scroll/)
- [Content-Aware Subtitle Layout arXiv 2512.12596](https://arxiv.org/pdf/2512.12596)
- [Kinetic Typography retention metrics](https://www.ikagency.com/graphic-design-typography/kinetic-typography/)
- [Frontify AI Brand Management](https://www.frontify.com/en/ai)
- [Audio Auto-Ducking AI](https://reelmind.ai/blog/ai-video-auto-duck-lower-background-music-for-dialogue)
- [ElevenLabs Latin American Voices](https://elevenlabs.io/text-to-speech/latin-american-accent)
- [Data Flywheels — Alex Smale](https://www.alexsmale.com/data-flywheels-usage-product-intelligence/)
- [AI Creative Testing ATTN Agency](https://www.attnagency.com/blog/ai-creative-testing-paid-social)
- [SpecifyUI iterative regeneration arXiv 2509.07334](https://arxiv.org/html/2509.07334v1)
- [Sora 2 vs Veo 3 vs Runway Gen-4](https://reezo.ai/blog/sora-2-vs-veo-3-vs-runway-gen-4-comparison-2025)
- [Batch Inference cost AWS Bedrock](https://aws.amazon.com/blogs/database/optimize-llm-response-costs-and-latency-with-effective-caching/)
- [LLM Latency optimization techniques](https://medium.com/athina-ai/solving-latency-challenges-in-llm-deployment-for-faster-smarter-responses-64ff301e40d3)
