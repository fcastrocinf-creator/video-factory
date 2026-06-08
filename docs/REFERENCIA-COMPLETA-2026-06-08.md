# 📘 REFERENCIA COMPLETA — Video Factory (verificada desde código, 2026-06-08)

> Generado por verificación multi-agente (18 lectores + crítico) sobre el CÓDIGO ACTUAL (incluye los fixes sin commit de la sesión 06-08). Es la referencia para entender la herramienta COMPLETA. Donde un doc viejo contradiga esto, manda el código.

## Índice
- 01-pipeline (subsistema de orquestación del pipeline)
- 02-modos-crear-ripear-aprender
- 03-guion-voz-tts
- 04-imagen
- 05-animacion
- 06-scene-planner: planificación de escenas y enrutamiento por componente visual
- 07-compositor-remotion
- 08-compuerta-jueces
- 09-brazo-reparacion (Repair Loop Subsystem)
- 10-kb-cerebro-consejo: Base de Conocimiento + Cerebro Evolutivo de Video Factory
- 11-validador-chat-ia
- 12-contratos-presets-brands
- 13-app-ui-seguridad
- 14-infra-db-config (Configuración de Base de Datos e Infraestructura)
- 15-human-loop-collab: Modo colaborativo + intervenciones del owner en vivo (co-creación scene-by-scene, reject con regeneración, pre-prompt assistant)
- 16-scripts-cli — Subsistema de scripts y utilidades CLI
- 17-lipsync-y-wan

---

# 01-Pipeline: Subsistema de orquestación

## Propósito
`apps/web/lib/pipeline.ts` (~2743 líneas) es el orquestador central de Video Factory. Coordina las **13 etapas** del pipeline desde un guion texto hasta un video renderizado. Emite escenas estáticas/animadas, validación de calidad obligatoria, y manejo de errores con entrega graceful (nunca deja al usuario sin video si es posible).

## Arquitectura: 3 modos operativos
El pipeline soporta 3 flujos según `PipelineOverrides.mode`:

1. **`'auto'` (default)** — Ejecuta todo sin pausa humana. Validadores IA corren en background.
2. **`'collaborative'` (v3.2 #116)** — Pausa **scene-por-scene** esperando aprobación vía `POST /api/runs/[id]/resume`. Concurrency=1 (sequential). Útil para auditoría en tiempo real.
3. **Flujo legacy** (`plano_fijo`) — Una única imagen estática con Veo opcional. Deprecated pero funcional.

### Bifurcación principal (línea 454)
```ts
const usesMultiEscena = preset.estrategia === 'multi_escena';
const wantsAnimation = preset.visualEngine.startsWith('veo-');
const isAnimatedFormat = fmtId === 'b-roll-animated' || fmtId === 'voiceover-animated' || 
                        fmtId === 'ugc-broll' || fmtId === 'ugc-testimony';
```

**Si `usesMultiEscena=true`:** flujo moderno (multi-escena + validators + animación). Cubre el 95% de los casos.
**Si `usesMultiEscena=false`:** flujo legacy (1 imagen + Veo talking head opcional). Raro.

---

## Las 13 etapas (en orden)

### B.1 — Script Processor (líneas 175-221)
**Entrada:** guion texto bruto.
**Salida:** `parsedScript` con campos `segments[]`, `narratorProfile`.

**Cambios recientes (29-may-2026):**
- Normalización a español neutro OBLIGATORIA (línea 220): `parsedScript.segments[].text = toNeutralSpanish(s.text)`.
  - La regla `Español neutro SIEMPRE` está en el candado de la compuerta (invariante del proyecto).
  - Esto afecta el guion ANTES de llegar al TTS y los subtítulos.

**Candado de validación:** Si `scriptInputResult.isErr()` → throw. No hay fallback.

### B.1.5 — Narrator Analyzer (líneas 187-213)
**Entrada:** `parsedScript`, `overrides.narratorGenderOverride`.
**Salida:** `narratorProfile` con `gender` ('male' | 'female' | 'neutral'), `ageRange`, `characterCard`.

**Lógica:**
- Si `overrides.narratorGenderOverride` está seteado (el usuario forzó en la UI), usalo directamente (líneas 191-204).
- Sino, llamamos a `narratorAnalyzer.run(parsedScript)` que infiere el género del guion con Claude (línea 206).

**CRÍTICO (línea 187-189):** "Corre ANTES de TTS para que la voz se elija según el gender inferido del guion."

### B.2 — TTS + Voice Selection + Cache (líneas 230-401)

#### B.2.1 — Voice Selection por Gender (líneas 239-259)
**CAMBIO RECIENTE (29-may-2026):** Fix del bug donde un narrador HOMBRE salía con voz MUJER.

```ts
if (!overrides.voiceOverride && parsedScript.narratorProfile) {
  const selectedVoice = selectVoiceForNarrator({
    defaultVoice: brand.defaultVoice,
    voiceLibrary: brand.voiceLibrary ?? [],
    narratorProfile: parsedScript.narratorProfile,
    logger,
    runId,
  });
  if (selectedVoice.voiceId !== brand.defaultVoice.voiceId) {
    brand = { ...brand, defaultVoice: selectedVoice };
  }
}
```

**Flujo de `selectVoiceForNarrator` (packages/blocks/tts-elevenlabs/src/voice-selector.ts:27-85):**
1. Si no hay `narratorProfile` o `narratorPresent=false` → devuelve `defaultVoice`.
2. Si `narratorProfile.gender` matchea `defaultVoice.gender` → devuelve `defaultVoice`.
3. Si NO matchea → busca en `voiceLibrary` una voz con el gender correcto, matcheada por `ageRange` (distancia de edad más cercana).
4. Si no hay match en library → fallback a `defaultVoice` con warning.

**La cache key (líneas 262-268)** ahora usa la voz CORRECTA (la elegida por gender, no la default genérica).

#### B.2.2 — TTS con Fallback (líneas 296-399)
**Primario:** ElevenLabs (mejor calidad).
**Fallback:** OpenAI TTS (si ElevenLabs falla por quota/auth/red).

**Cache hit (líneas 296-328):**
- Si `checkTtsCache(elevenlabsCacheKey)` devuelve un `.mp3` existente, lo copiamos a `workDir/audio.mp3`.
- FIX CRÍTICO (v3.2 #142, línea 307): usamos `getVideoDurationSec()` (ffmpeg bundled en @remotion) en vez de `ffprobe` crudo del sistema (que no existe en PATH).
  - Fallback inteligente: si ffmpeg falla, estimar desde texto (~15 caracteres/seg ES).

**Sin voz (overrides.skipVoice):**
- No llamamos a TTS. Construimos un `audioResult` con duración estimada (líneas 272-295).
- El compositor renderiza un video mudo (audioTrack.filePath vacío).

### B.3 — Subtitles (líneas 411-443)
**ESTADO ACTUAL (25-may-2026):** Subtítulos automáticos DESACTIVADOS por decisión del owner.
- Antes: llamábamos a `subtitlesGoogle.run(audioTrack)`.
- Ahora: generamos un `subtitleTrack` VACÍO pero válido (línea 430-438).
  - `language: 'es'`, `words: []`, `lines: []`.
  - El compositor NO renderiza ningún overlay de subs.

**Para reactivar:** descomentar líneas 425-428 + comentar líneas 430-438.

### B.4 — Scene Planner (líneas 529-759)

#### B.4.0 — Auto-trim (líneas 613-660)
**Problema:** Scene-planner divide tiempo proporcional a CHARACTER COUNT, pero la velocidad real de habla varía (pausas, énfasis).
**Solución:** Usar `audioTrack.segments[]` (timings REALES del TTS por segmento) para mapear cada escena a su ventana exacta de audio.

**Función `alignScenesToAudioTiming` (líneas 2578-2742):**
- Construye `fullScript` concatenando segments del parsedScript.
- Para cada segmento, registra su rango de caracteres (`startChar..endChar`) y tiempo (`startSec..endSec`).
- Para cada escena, busca su `text` en `fullScript` usando búsqueda fuzzy (primero exacta, luego primeras 8 palabras).
- Mapea char→seconds y ajusta `scene.endTimeSeconds` al timing real del audio.
- Fuerza monotonía: `scene[i].startTimeSeconds = scene[i-1].endTimeSeconds`.
- Última escena siempre cubre hasta `audio.durationSeconds` (sin colas mudas).

#### B.4.1 — Duration Normalization (líneas 662-698)
**Red de seguridad:** Si la última escena termina ANTES que el audio TTS, extendemos su `endTimeSeconds` hasta `audio.durationSeconds`.
- Previene el bug "video se corta, audio sigue sonando, pantalla negra".

#### B.4.4 — Fork Propagation (líneas 761-857)
**Context:** Si el run es un fork (reusa escenas pre-aprobadas), aplicamos correcciones cross-run ANTES de image-gen.
- Leemos `owner-feedback-memory` (comentarios del owner en runs anteriores).
- Pasamos esos comentarios a `propagateCorrections()` que ajusta los `imagePrompts` de las escenas NUEVAS (no las pre-aprobadas).

#### B.4.5 — Ingredients Vision Refiner (líneas 859-880)
**Opt-in:** Si la marca tiene assets (`brand.ingredients.assets`), refinamos `imagePrompts` para escenas que mencionan productos.
- Usa GPT-4o vision para analizar el prompt + visuals de los assets.
- Costo: ~$0.003 por imagen.

#### Word Sync + Micro-Escenas (líneas 710-759)
**Control:**
- `overrides.wordSync` (opt-in desde UI).
- `preset.subtitles.wordSyncMicroScenes` (configuración del preset).

**Si activado (y hay ELEVENLABS_API_KEY):**
- Llamamos a `fetchWordTimings()` para obtener timings POR PALABRA (no solo por segmento).
- `alignScenesToWords()` alinea escenas a palabras exactas.
- `expandEnumerationScenes()` expande listas/enumeraciones en micro-escenas (un corte por ítem).
  - Controla: `overrides.microSceneIndices` (índices de escenas que el usuario eligió convertir).
  - NO expande en runs forkeados (preservar índices estables).

### B.5 — Image-Gen-Multi (líneas 904-1258)

#### Provider Chain (líneas 906-989)
**Orden de fallback automático:**
1. OpenAI `gpt-image-1` (primario, sin daily caps, ~$0.04/img medium, 15-30s).
2. Gemini `gemini-2.5-flash-image` (Nano Banana, cuota independiente de Vertex, mejor para pediátrico/médico).
3. Vertex AI Imagen (`imagen-4.0-fast/std/ultra`, project quota, sin daily caps).
4. Google AI Studio Imagen (`imagen-4.0-*`, daily caps, 170/día).
5. Higgsfield `flux-pro/kontext/max/text-to-image` (si keys seteadas).
6. fal.ai `flux-pro/v1.1` + `flux/dev` (si FAL_API_KEY seteada).

**Criterios de selección:**
- Si falla OpenAI, siguiente en cadena.
- Cada proveedor puede hacer múltiples intentos si el validator lo pide.

#### Rip Fidelity (líneas 1009-1065)
**Trigger:** `overrides.referenceVideoPath` (el usuario subió un video de referencia).

**Flujo:**
- Extraemos keyframes del video original.
- Generamos CADA escena con un loop iterativo, comparando contra los keyframes hasta lograr ≥95% similitud o agotar intentos.
- Las imágenes resultantes se persisten en `workDir/scene_XX.png`.
- **Salta el ImageGenMultiBlock normal** (las imágenes ya están).

**Heurística de estilo (líneas 1017-1024):**
- Si `styleBase` contiene "phone-shot|smartphone|selfie|photo-realistic|ugc|real person|natural lighting" → `preferRealistic=true`.
- Prioriza Flux/gpt-image-1 para realismo.

#### Character Anchor (líneas 1121-1152)
**Control:** `overrides.identityAnchor` u `preset.visualStyle.consistentCharacter`.

**Si activado (y hay GOOGLE_AI_API_KEY):**
- Generamos UN anchor de la persona (foto de referencia).
- Se pasa a cada provider para mantener consistencia visual (misma persona en antes/después/progresión).
- Persistido en `workDir/character-anchor.png`.

#### ImageGenMultiBlock + Validator (líneas 1154-1210)
**Constructor:**
```ts
const imageMulti = new ImageGenMultiBlock({
  concurrency: 8,
  minIntervalMs: 3500,
  providerChain,
  referenceImage: presetReferenceImage,
  characterAnchorImage,
  anatomyMode: routeProfile.validator.anatomyMode,
  validate: true, // SIEMPRE
  maxValidationRetries: 3,
  minPassScore: 85,
  validateSequence: true,
  minSequenceScore: 80,
  narratorProfile: sceneTrack.narratorProfile,
  styleBase: sceneTrack.styleBase,
  fastMode: true,
  useClaudeJudge: true, // M2: Haiku 4.5
  claudeJudgeOptions: { ... },
});
```

**`anatomyMode`** (route-profiles.ts):
- `'lenient'` (cartoon, ilustrado): acepta anatomía estilizada.
- `'strict'` (UGC, real, default): bloquea defectos anatómicos (dedos extras, manos fusionadas, etc.).

### B.5.5 — Scene Animator (líneas 1266-1714)

#### Routing por Estilo (líneas 1313-1327)
```ts
const preferHiggsfield = 
  formatId.startsWith('ugc-') ||
  /realista|fotorealista|real|ugc/i.test(styleId);
```

**Si `preferHiggsfield=true`:**
- Primary: Higgsfield Soul DoP (mejor realismo facial humano para UGC).
- Kling v3 (mejor warping control para rostros).

**Si `preferHiggsfield=false`:**
- Primary: Kling v2-6 (B-ROLL animado, Pixar, acuarela, comic).

**Fallback: Veo** (siempre disponible).

#### Ken Burns (línea 1337)
**Contexto (v3.2 #143, 29-may-2026):** Revertido el forzado de Ken Burns.
- Antes: intentamos usar Ken Burns en estilos ilustrados para evitar drift de Kling.
- Ahora: animación REAL (Kling) es lo default.
- Ken Burns queda **opt-in** vía `KEN_BURNS_ONLY=1`.

**Pero:** Si es estilo ilustrado (líneas 1286-1295), el animator corre con `skipVideoGen=true`:
- Usa la imagen ESTÁTICA aprobada con movimiento Ken Burns cinematográfico (zoom + paneo + parallax).
- Evita que Kling re-encuadre (close-up, pierde concepto).

#### Concurrency & Memory Management (líneas 1363-1371)
**Contexto (v3.2 #141, 29-may-2026):** Crash del dev server por heap exhausted.
- Root cause: 5 scenes animando + 5 llamadas VALIDATOR simultáneas (extended thinking + 10 frames base64 cada una).
- Fix: `concurrency = 2` cuando VALIDATOR activo en auto mode, `concurrency = 1` en collaborative.

```ts
concurrency:
  overrides.mode === 'collaborative'
    ? 1
    : process.env['ANTHROPIC_API_KEY'] &&
        !process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')
      ? 2
      : klingAccessKey && klingSecretKey
        ? 5
        : 4,
```

#### VALIDATOR CHAT IA (líneas 1377-1500)
**Post-clip gate:** Después de animar cada escena, VALIDATOR CHAT IA (Claude Sonnet 4-5) extrae 3 keyframes del clip, compara con la imagen estática, emite pass/fail.

**Si `fail`:**
- Emite una acción: `regenerate-image` (con prompt corregido).
- El animator re-genera solo esa imagen con el nuevo prompt (no re-anima).

**Anti-patterns reportados:** Via `onAntiPatternDetected`, se envían al `scenePatchTracker`.

**Holistic Review (líneas 1527-1690):**
Después de que cada escena pasó su validator individual, VALIDATOR mira el VIDEO ENTERO como secuencia (contact sheet) y detecta:
- Character drift.
- Palette inconsistencies.
- Pacing monotone.
- Hook débil / CTA débil.

**Auto-loop post-holistic (líneas 1593-1672):**
- Si holistic recomienda regenerar escenas, lo hacemos de inmediato.
- Cada escena se regenera con la fix del holistic + anti-patterns fortificados.
- NO re-validamos individualmente (ahorraría tiempo).

### B.6 — Compositor (líneas 1751-1799)
**Entrada:** `RenderJob` con scene-track (imágenes/videos, timings).
**Salida:** `final.mp4` en `outputPath`.

**TextOverlays (línea 1766):**
**CRÍTICO:** Strip TODOS los textOverlays antes del render.
```ts
sceneTrack: {
  ...sceneTrackWithImages,
  scenes: sceneTrackWithImages.scenes.map((s) => ({ ...s, textOverlays: [] })),
},
```
- El owner NO quiere texto incrustado (etiquetas tipo "METFORMINA", "B12").
- El scene-plan.json conserva los overlays (el editor manual los puede reactivar a pedido).

### M5 — Post-Render Judge (líneas 1801-2098)
**Entrada:** video renderizado (MP4).
**Salida:** `post-render-report.json` + editor-conversation.md (si hay cambios).

**Comprobaciones:**
- Coverage: cada scene tiene imagePath/videoPath.
- Duration: coherencia audio vs scene-plan vs video final.
- Visual quality sample: re-juzga 3 scenes (primera, medio, última).
- Subtítulos: text quality (sin gibberish, idioma OK).

**M6 Editor Loop (líneas 1878-2082):**
Iterativo (max 3 iteraciones). Editor IA puede emitir:
- `extend-duration` / `trim-duration` → ajusta `scene.endTimeSeconds`, re-render.
- `adjust-prompt` → guarda el prompt para futuras runs.
- `regenerate-scene` → re-genera imagen vía `regenerateSingleScene()`.
- `manual-fix` → escala a usuario, entrega con advisory.

**Escape Hatch (línea 2025):**
Si el editor NO aprueba tras 3 iteraciones:
- NO throw (antes de v3.2 #105, esto tumbaba el run).
- Persistir advisory en `editor-advisory.md`.
- Marcar status `'completed-with-warnings'` en vez de `'completed'` o `'failed'`.
- Owner recibe el video + instrucciones de qué revisar.

### Cap 5 — Subtítulos ZapCap (líneas 2170-2199)
**Control:** `overrides.subtitlesZapcap` u `preset.subtitles.autoZapcap.enabled`.

**Si activado (y ZapCap configurada):**
- Quemamos subtítulos estilo CapCut sobre el render final → `final-subtitled.mp4`.
- Best-effort: si falla, el video se entrega sin subtítulos quemados + advisory.

### ⚠️ CANDADO: Validación Obligatoria (líneas 2203-2235)
**Invariante del proyecto (fundacional):**

NINGÚN video se marca "completed" (listo) sin pasar por la compuerta que VE+OYE (Gemini).

**Garantías:**
- Corre SIEMPRE con `await` (no fire-and-forget).
- `useGemini: true` (no es opt-in).
- El ESTADO FINAL DEPENDE de su veredicto:
  - `veredicto = 'pass'` + sin avisos → status `'completed'`.
  - `veredicto = 'revisar'` / `'fail'` / `'no-verificado'` **O** hay avisos → status `'completed-with-warnings'`.
  - NUNCA `'completed'` a ciegas.

**Si falla (sin Gemini/cuota/error) → gateVeredicto = `'no-verificado'` (fail-loud).**

**Guardián:** `apps/web/lib/quality-gate-wiring.test.ts` rompe si alguien intenta desconectarla.

---

## Inputs (PipelineOverrides)

```ts
interface PipelineOverrides {
  voiceOverride?: string | null;                    // voz específica UI (antes de gender-selection)
  narratorGenderOverride?: 'male'|'female'|'neutral'|null;  // fuerza gender del narrador
  referenceVideoPath?: string | null;               // rip de alta fidelidad
  productId?: string | null;                        // detectar mismatches visual-producto
  mode?: 'auto' | 'collaborative';                  // ejecución con/sin pausa por scene
  subtitlesZapcap?: boolean | null;                 // subtítulos quemados finales
  identityAnchor?: boolean | null;                  // anchor de consistencia de persona
  wordSync?: boolean | null;                        // word-level alignment + micro-escenas
  kenBurns?: boolean | null;                        // movimiento Ken Burns inicial
  disableAnimation?: boolean | null;                // no anima (estáticas)
  skipVoice?: boolean | null;                       // video mudo
  microSceneIndices?: number[] | null;              // escenas a convertir en micro-escenas
  reusePlanId?: string | null;                      // reusar plan de preview existente
}
```

---

## Outputs (persist a disco)

### Artifacts principales
- **`final.mp4`** (outputPath) — video final listo.
- **`scene-plan.json`** — definición de escenas (imagePath, videoPath, timings, textOverlays).
- **`render-job.json`** — RenderJob completo (para re-renderizar sin regenerar imágenes).
- **`audio.mp3`** — pista de audio TTS.
- **`character-anchor.png`** (opt) — referencia visual de la persona.
- **`fork-metadata.json`** (opt, fork mode) — metadata del run que se forkeó.
- **`post-render-report.json`** — veredicto del M5 post-render judge.
- **`editor-conversation.md`** — historial del M6 editor loop.
- **`editor-advisory.md`** (opt) — mensaje de escape hatch si M6 no aprobó.
- **`run-report.md`** (opt) — summary del VALIDATOR CHAT IA.
- **`final-subtitled.mp4`** (opt) — video con subtítulos ZapCap quemados.

### Estado en DB (runs tabla)
```ts
interface RunUpdate {
  status: 'pending' | 'running' | 'completed' | 'completed-with-warnings' | 'failed';
  currentStep: string | null;
  progress: number;
  outputPath: string;
  errorMessage?: string;
  durationSeconds: number;
  estimatedCostUsd: number;
  imageCount: number;
  ttsCharsBilled: number;
  workDir: string;
  startedAt: Date;
  completedAt?: Date;
  pausedAtSceneIndex?: number | null;  // modo collaborative
  awaitingApproval?: boolean;           // modo collaborative
}
```

---

## Wirings no-obvios

### 1. Voice Selection ANTES de TTS
**Orden crítico:**
1. Analizar narratorProfile (B.1.5) → detectar gender del narrador.
2. Elegir voz por gender (B.2.1) → `selectVoiceForNarrator()`.
3. Actualizar brand.defaultVoice con la voz elegida (línea 248).
4. Usar la voz CORRECTA en la cache key (línea 262).
5. Pasar a TTS (línea 330).

**Bug original:** La cache key usaba SIEMPRE `brand.defaultVoice` (femenina en biozentra) → un villano HOMBRE salía con voz de MUJER. El fix (línea 239-259) invierte el orden: PRIMERO elegir voz por gender, DESPUÉS usar en cache y TTS.

### 2. TextOverlays NO se renderizan
**El pipeline EMITE escenas con `textOverlays[]` (scene-planner genera), PERO los STIPA antes del compositor (línea 1766).**

Razón: El owner no quiere texto incrustado. El scene-plan.json conserva los overlays para que el editor manual los reactive a pedido.

### 3. plannerTargetSceneCount: Micro-escenas en Ripeo
**Línea 407-409:**
```ts
const plannerTargetSceneCount = overrides.referenceVideoPath
  ? Math.min(14, Math.max(8, Math.round(audioTrack.durationSeconds / 2.2)))
  : undefined;
```

**Si es rip (referenceVideoPath):** Aumentar densidad de cortes (más escenas, más cortas, ~1 corte cada 2.2s) para acercarse al ritmo del referente.
**Si NO es rip:** `undefined` → scene-planner usa su defecto (~25 escenas/minuto genérico).

### 4. isAnimatedFormat: Selector de flujo
**Línea 461-465:**
```ts
const isAnimatedFormat = 
  fmtId === 'b-roll-animated' ||
  fmtId === 'voiceover-animated' ||
  fmtId === 'ugc-broll' ||
  fmtId === 'ugc-testimony';
```

**IMPORTANTE:** UGC (ugc-broll / ugc-testimony) también se anima. Antes el gate solo dejaba pasar b-roll-animated/voiceover-animated → los UGC salían estáticos. Ahora entran al animator.

### 5. preferHiggsfield: Routing por UGC
**Línea 1319-1321:**
```ts
const preferHiggsfield = 
  formatId.startsWith('ugc-') ||
  /realista|fotorealista|real|ugc/i.test(styleId);
```

**Si `preferHiggsfield=true`:**
- Primary: Higgsfield Soul DoP (mejor realismo facial).
- Kling v3 (menos warping).

**Si `preferHiggsfield=false`:**
- Primary: Kling v2-6 (estilos ilustrados, B-ROLL).

### 6. Cache Keys: TTS + Fallback
**Primario (ElevenLabs):** Keyed por `(script, voiceId, modelId, speedMultiplier, 'elevenlabs')`.
**Fallback (OpenAI):** Keyed por `(script, 'openai-default', 'tts-1', 1.0, 'openai')`.

**Las 2 caches son independientes.** Si ElevenLabs está cacheado pero el usuario fuerza fallback, usamos OpenAI cache distinta.

### 7. Editor Loop: No auto-aplica
**M6 (línea 1980-2082)** propone acciones, PERO:
- `extend-duration` / `trim-duration` / `regenerate-scene` → se EJECUTAN.
- `adjust-prompt` → se GUARDA (no re-genera imagen en el run actual).
- Si no aprueba → entrega con advisory (escape hatch).

**Ninguna mutación silenciosa.** El owner siempre ve qué pasó.

### 8. Fork Propagation: Correcciones Cross-Run
**Si el run es fork (línea 769):**
1. Leemos owner-feedback-memory (comentarios en runs anteriores).
2. Pasamos a `propagateCorrections()` que ajusta imagePrompts de las escenas NUEVAS.
3. Las escenas pre-aprobadas (pre-aprobadas por el usuario) son INMUTABLES (línea 1603).

### 9. System Context Injection (M9)
**Línea 1973-1976:** El editor loop recibe `projectContext` (snapshot del sistema) vía `getSystemContextForPrompt()`.
- Permite que el editor IA razone con el estado actual del proyecto (brand, preset, KB, etc.).

### 10. Cerebro Evolutivo (M7): Scenery Patch Tracker
**Línea 1000-1007:** `scenePatchTracker` se crea una sola vez (hoisted al scope del pipeline).
- Usado por VALIDATOR CHAT IA (línea 1456) para reportar anti-patterns.
- Usado por el preview-judge (M2) también.
- Después del run (línea 2299-2341), `proposePatchesFromOwnerComments()` convierte comentarios en patches propuestos → UI `/admin`.

---

## Estado del Código (Correcciones Recientes)

### v3.2 #142 (29-may-2026): FFmpeg Bundled
- **Problema:** ffprobe del sistema no existe en PATH → fallaba duración de audio.
- **Fix:** Usar `getVideoDurationSec()` (ffmpeg bundled en @remotion) en lugar de spawnSync('ffprobe').
- **Impacto:** Bug crítico de duración (scenes 6-11s imposibles) solucionado.
- **Afecta líneas:** 307, 362.

### v3.2 #105 (28-may-2026): Escape Hatch Graceful
- **Problema:** Si M6 editor loop no aprobaba → throw → status='failed' → owner sin video.
- **Fix:** Persistir advisory, marcar status='completed-with-warnings' (entregamos video + instrucciones).
- **Afecta líneas:** 2025-2071, 2249-2252.

### v3.2 #143 (29-may-2026): Revert Ken Burns Forzado
- **Problema:** Intentamos forzar Ken Burns en estilos ilustrados (evitar drift Kling).
- **Fix:** Revertir a animación REAL (Kling default), Ken Burns solo opt-in vía `KEN_BURNS_ONLY=1`.
- **Motivo:** Owner quería animación real, no imágenes con zoom.
- **Afecta línea:** 1337.

### v3.2 #141 (29-may-2026): Memory Management
- **Problema:** 5 scenes animando + 5 VALIDATOR calls simultáneas → heap exhausted → crash.
- **Fix:** `concurrency=2` en auto mode (si VALIDATOR activo), `concurrency=1` en collaborative.
- **Impacto:** -60% pico de memoria.
- **Afecta líneas:** 1363-1371.

### v3.2 #135 (29-may-2026): Fork Scene Preservation
- **Problema:** Re-generación de imágenes de escenas pre-aprobadas en forks.
- **Fix:** Filtrar escenas pre-aprobadas antes de image-gen, volver a fusionar después.
- **Afecta líneas:** 486-487, 1220-1257.

### v3.2 #104 (28-may-2026): Run Report
- **Nuevo:** Generar markdown autogenerado del trabajo del VALIDATOR.
- **Contenido:** Stats, per-scene table con scores, anti-patterns, recomendaciones.
- **Afecta líneas:** 1735-1748.

---

## Parámetros de Environment

```bash
ELEVENLABS_API_KEY            # TTS primario
OPENAI_API_KEY                # TTS fallback + image-gen
GOOGLE_AI_API_KEY             # Gemini (Nano Banana) + Veo
GCP_PROJECT_ID                # Vertex AI Imagen
GOOGLE_APPLICATION_CREDENTIALS # Vertex auth
FAL_API_KEY                   # fal.ai Flux
HIGGSFIELD_KEY_ID             # Higgsfield Soul
HIGGSFIELD_KEY_SECRET         # Higgsfield Secret
ANTHROPIC_API_KEY             # Claude (M2, M5, M6, M8, M9)
KLING_ACCESS_KEY              # Kling v2-6 / v3
KLING_SECRET_KEY              # Kling Secret
DISABLE_REAL_ANIMATION=1      # Fallback a CSS (debug)
KEN_BURNS_ONLY=1              # Fuerza Ken Burns (debug)
VF_STORAGE_DIR                # Raíz de storage (default: /storage)
ADMIN_PASSWORD                # /admin protegido
```

---

## Gotchas & Trampas

1. **Voice Selection antes de TTS:** Fácil olvidar que `selectVoiceForNarrator()` debe correr ANTES de la cache key. El bug original tuvo a villanos HOMBRES con voz MUJER.

2. **TextOverlays stripped:** El scene-planner GENERA textOverlays, el pipeline los STIPA antes del compositor. Parecería un error, pero es intencional (owner no quiere texto incrustado).

3. **plannerTargetSceneCount solo en rips:** Si `referenceVideoPath` NO está seteada, `plannerTargetSceneCount` es `undefined` → scene-planner usa su defecto. No es automático en todos los runs.

4. **isAnimatedFormat incluye UGC:** Fácil olvidar que `ugc-broll` / `ugc-testimony` también se animan. El gate original (antes de la corrección) solo dejaba pasar b-roll-animated/voiceover-animated.

5. **Validación obligatoria NO es opt-in:** El candaco (línea 2203) SIEMPRE corre. No existe flag para saltarla. Un test guardián (quality-gate-wiring.test.ts) lo verifica.

6. **Cache keys DEBEN incluir voz correcta:** Si la cache key usa `defaultVoice` genérica, recicla audio incorrecto (villano HOMBRE con voz MUJER). SIEMPRE usar la voz elegida por gender.

7. **FFmpeg bundled, no del sistema:** `getVideoDurationSec()` usa ffmpeg de @remotion. NO intentar usar `ffprobe` crudo (no existe en PATH en producción).

8. **Fork scenes pre-aprobadas son INMUTABLES:** `preApprovedSceneIndices` NUNCA se deben regenerar (línea 1603), ni por holistic review (línea 1604), ni por editor loop (línea 1888). El usuario las aprobó.

9. **Editor loop: escape hatch graceful:** No throw si M6 no aprueba. Usar advisory + status='completed-with-warnings'. Mejor entregar video con avisos que no entregar nada.

10. **Cerebro evolutivo usa scenePatchTracker:** Reportar anti-patterns vía `scenePatchTracker.report()` (línea 1456) que se convierte en propuestas de patches. NO emitir `recordSystemicPattern()` paralelo (duplicaría).

11. **ZapCap best-effort:** Si falla, el video se entrega sin subtítulos quemados + advisory. Nunca bloquea el run.

12. **Image-gen-multi ALWAYS valida:** `validate: true` no es opcional (línea 1161). El anatomyMode cambia según el perfil (cartoon vs real), pero la validación siempre corre.

**⚠️ Gotchas (01-pipeline (subsistema de orquestación del pipeline)):**
- Voice selection (selectVoiceForNarrator) DEBE correr ANTES de TTS cache key, no después — bug original: villano HOMBRE con voz MUJER por usar defaultVoice genérica
- TextOverlays son GENERADOS por scene-planner pero STRIPADOS antes del compositor (línea 1766) — intencional, el owner no quiere texto incrustado
- plannerTargetSceneCount (micro-escenas densas en ripeo) SOLO se calcula si hay referenceVideoPath — en runs normales es undefined
- isAnimatedFormat INCLUYE ugc-broll/ugc-testimony (línea 464) — fácil olvidar que UGC también se anima
- Validación de calidad (compuerta Gemini) NUNCA es opt-in — SIEMPRE corre con await, el estado final DEPENDE de su veredicto
- Cache keys TTS: DEBEN usar la voz CORRECTA (elegida por gender), no la defaultVoice genérica
- FFmpeg: usar getVideoDurationSec() (bundled @remotion), NO ffprobe del sistema (no existe en PATH)
- Fork scenes pre-aprobadas son INMUTABLES — línea 1603 y 1888 las excluyen de regeneración
- Editor loop (M6): NO throw si no aprueba — escape hatch graceful con advisory + status=completed-with-warnings
- Anti-patterns: reportar vía scenePatchTracker.report() (línea 1456), NO recordSystemicPattern() paralelo
- ZapCap: best-effort, si falla NO bloquea el run — entrega video sin subtítulos + advisory
- Image-gen-multi SIEMPRE valida (validate=true, línea 1161) — anatomyMode varía, pero validación es obligatoria


---

# Subsistema 02: Los 3 Modos (Crear, Ripear, Aprender)

## Propósito

Video Factory permite a los usuarios producir videos verticales 9:16 (para TikTok/Reels) de **tres formas distintas pero que comparten un mismo pipeline central**:

1. **CREAR** — Partir de cero: escribir un guion + elegir marca/preset → generar video con escenas, voz, subtítulos
2. **RIPEAR** — Copiar un anuncio exitoso: subir video de referencia → analizar su estilo → adaptarlo a tu producto
3. **APRENDER** — Capturar un formato: subir video → Claude entiende el estilo → genera preset reutilizable en futuros videos

Todos convergen en `runPipeline` (apps/web/lib/pipeline.ts), que es la orquestación core que genera las escenas, TTS, validaciones y composición final.

## Arquitectura de flujos

### Modo 1: CREAR (entrada: guion directo)

```
┌─────────────────────────────────────┐
│  POST /api/generate                 │
│  (apps/web/app/api/generate/route)  │
└──────────────┬──────────────────────┘
               │
    Payload: {
      brandId,       // marca (nombre/idioma/voces)
      presetId,      // estilo visual (promptTemplate, negativePrompt, etc.)
      productId,     // opcional: producto específico
      script,        // guion en texto
      voiceOverride, // opcional: voz específica
      narratorGenderOverride, // optional: 'male'|'female'
      mode,          // 'auto' (default) o 'collaborative'
      ... (opcionales: voice, subtitles, animation, kenBurns, microSceneIndices)
    }
               │
               ▼
    ┌─────────────────────────────────┐
    │ 1. Validar request (Zod schema) │
    │    GenerateRequestSchema        │
    └──────────────┬──────────────────┘
                   │
                   ▼
    ┌─────────────────────────────────┐
    │ 2. Insertar run en DB           │
    │    status='pending'             │
    │    scriptRaw=script             │
    └──────────────┬──────────────────┘
                   │
                   ▼
    ┌─────────────────────────────────┐
    │ 3. Disparar runPipeline() async │
    │    (no espera, retorna runId)   │
    └──────────────┬──────────────────┘
                   │
                   ▼
              (Continúa en Pipeline Central)
```

**Entrada:** guion en texto puro.
**Punto de entrada:** `POST /api/generate` → genera `runId`, dispara pipeline en background.
**Código:** apps/web/app/api/generate/route.ts líneas 11-102.

---

### Modo 2: RIPEAR (entrada: video de referencia)

```
┌──────────────────────────────────────┐
│  Paso 1: UPLOAD & ANALYZE            │
│  POST /api/rip/upload                │
│  (apps/web/app/api/rip/upload/route) │
└──────────────┬───────────────────────┘
               │
    Payload: FormData { video: File }
               │
               ▼
    ┌──────────────────────────────────┐
    │ 1. Validar MIME + size (<200MB)  │
    │ 2. Guardar en storage/rips/[id]/ │
    │    source.<ext>                  │
    │ 3. DB insert rips (status=analyzing)
    │ 4. Dispara analyzeAd() async     │
    │    (Gemini multimodal)           │
    └──────────────┬───────────────────┘
                   │
    (Gemini analiza: escenas, narrador, paleta, hook → AdAnalysis JSON)
                   │
                   ▼
    DB update: status='analyzed', analysisJson=...

┌──────────────────────────────────────┐
│  Paso 2: BUILD PRESET DINÁMICO       │
│  POST /api/rip/[id]/build-preset     │
│  (apps/web/app/api/rip/[id]/build-preset/route)
└──────────────┬───────────────────────┘
               │
    Payload: { brandId }
               │
               ▼
    ┌──────────────────────────────────┐
    │ 1. Leer rip.analysisJson         │
    │ 2. buildAndPersistDynamicPreset()│
    │    → PresetConfig sintetizado    │
    │    (mapea hookType, format,      │
    │     visualEngine, promptTemplate)│
    │ 3. Persistir en                  │
    │    packages/presets/pending/     │
    │    learned-[random].preset.json  │
    └──────────────┬───────────────────┘
                   │
         Devuelve: presetId
                   │
                   ▼
┌──────────────────────────────────────┐
│  Paso 3: RIPEAR CON EL PRESET        │
│  POST /api/rip/[id]/rip              │
│  (apps/web/app/api/rip/[id]/rip/route)
└──────────────┬───────────────────────┘
               │
    Payload: {
      brandId,
      presetId,           // preset dinámico del paso 2
      productId,
      literalScript,      // optional: guion exacto sin adaptar
      narratorGenderOverride,
      fidelityMode: 'fast'|'high'  // 'high'=loop iterativo vs original
    }
               │
               ▼
    ┌──────────────────────────────────┐
    │ 1. Validar rip.status='analyzed' │
    │ 2. Llamar ripAd()                │
    │    (apps/web/lib/ad-ripper.ts)   │
    └──────────────┬───────────────────┘
                   │
                   ▼
         (Dentro de ripAd)
         • Si literalScript: usar EXACTO (no adaptar)
         • Si no: Gemini adapta el guion original
           - Traduce al idioma de la marca
           - Reemplaza nombre/descripción del producto
           - Mantiene estructura narrativa, emociones, beats
         • Inferir narratorGender del análisis original
                   │
                   ▼
    ┌──────────────────────────────────┐
    │ 3. Insert run en DB              │
    │ 4. Disparar runPipeline()        │
    │    con referenceVideoPath (si    │
    │    fidelityMode='high')          │
    └──────────────┬───────────────────┘
                   │
              (Continúa en Pipeline Central)
```

**Entrada:** archivo .mp4/.mov/.webm (≤200 MB).
**Flujo:** 3 pasos secuenciales, el usuario interactúa entre cada uno.
**UI:** /rip → /rip/[id] → seleccionar marca y opción de ripearlo.
**Código clave:**
- Upload: apps/web/app/api/rip/upload/route.ts (líneas 1-107)
- Análisis: apps/web/lib/ad-analyzer.ts (Gemini multimodal)
- Build preset: apps/web/app/api/rip/[id]/build-preset/route.ts (líneas 1-88)
- Ripear: apps/web/app/api/rip/[id]/rip/route.ts (líneas 1-117)

---

### Modo 3: APRENDER (entrada: video de referencia, salida: preset reusable)

```
┌───────────────────────────────────────┐
│  Paso 1-2: UPLOAD & ANALYZE           │
│  (Igual al Modo 2, Paso 1-2)          │
│  POST /api/rip/upload                 │
│  POST /api/rip/[id]/build-preset      │
└───────────────────┬───────────────────┘
                    │
         Obtener: rip + análisis + preset dinámico
                    │
                    ▼
┌───────────────────────────────────────┐
│  Paso 3: LEARN PRESET ITERATIVAMENTE  │
│  POST /api/rip/[id]/learn-preset      │
│  (apps/web/app/api/rip/[id]/learn-preset/route)
└───────────────────┬───────────────────┘
               │
    Payload: {
      targetScore: 95 (default), // 0-100: calidad de match
      maxIterations: 4 (default),
      displayNameOverride: "..."
    }
               │
               ▼
    runPresetLearningLoop():
    ┌────────────────────────────────────┐
    │ Iter 1:                            │
    │ • understandVideo(video)           │
    │   → VideoUnderstanding + keyframes │
    │ • autoLearnPresetFromVideo()       │
    │   → PresetConfig v1               │
    │ • pickReferenceFrameIndex()        │
    │   → frame más representativo      │
    │ • generateImageWithReference()     │
    │   → test image usando preset v1   │
    │ • compareImagesWithVision()        │
    │   → score (palette/composition/    │
    │     character/mood sub-scores)    │
    │ • Si score >= targetScore:        │
    │   APROBADO → persistir preset     │
    │   final, return approved=true     │
    └────────────────────────────────────┘
                   │
          Si score < targetScore:
          Continuar iteraciones
                   │
                   ▼
    ┌────────────────────────────────────┐
    │ Iter N (2-maxIterations):          │
    │ • refinePromptTemplate()           │
    │   Claude Sonnet refina el prompt   │
    │   según hint del score anterior    │
    │   (agregar hex colors, composition │
    │    details, mood words, etc.)     │
    │ • generateImageWithReference()     │
    │   con nuevo prompt                │
    │ • compareImagesWithVision()        │
    │   → nuevo score                    │
    │ • Si mejora O score >= target:     │
    │   Aprobar y salir                 │
    └────────────────────────────────────┘
                   │
    Resultado final:
    • preset final (mejor visto)
    • finalScore
    • approved: bool
    • exhausted: bool (agotó maxIterations)
    • iterations: [{ iteration, score, 
                     details, hint, ... }]
                   │
                   ▼
    ┌────────────────────────────────────┐
    │ 4. Persistir preset final          │
    │    packages/presets/pending/       │
    │    learned-auto-[uuid].preset.json │
    │    learned-auto-[uuid].iterations  │
    │    .json (reporte de iters)        │
    └────────────────────────────────────┘
```

**Entrada:** video original.
**Salida:** preset auto-aprendido + iteraciones de refinement.
**Loop iterativo:** entender → generar test → comparar → refinar prompt → repetir hasta score ≥ target o agotadas iteraciones.
**Costo:** ~$0.40-1.20 por loop (4 iters, target 95%).
**Tiempo:** ~90-240s.
**UI:** Botón "🧠 Aprender estilo" en /rip/[id] (visible cuando rip.status='analyzed').
**Código clave:**
- Endpoint: apps/web/app/api/rip/[id]/learn-preset/route.ts (líneas 1-104)
- Loop: apps/web/lib/preset-learning-loop.ts
- Understanding: apps/web/lib/video-understander.ts (Claude multimodal sobre keyframes)
- Auto-learn: apps/web/lib/auto-learn-preset.ts

---

## Pipeline Central (`runPipeline`)

Todos los 3 modos convergen en esta función orquestadora. Su responsabilidad:

```
runPipeline(runId, brandId, presetId, scriptText, overrides)
  ↓
1. Cargar brand + preset
2. Aplicar voice/gender overrides
3. Normalizar guion a español neutro (toNeutralSpanish)
4. scriptProcessor: estructurar guion
5. narratorAnalyzer: detectar tono, edad
6. TTS (ElevenLabs / OpenAI): generar voz
7. ScenePlannerBlock: dividir script en escenas (Gemini scene-planner)
8. ImageGenMultiBlock: generar imagen para cada escena
   - Si referenceVideoPath + fidelityMode='high':
     rip-fidelity-aligner: loop iterativo vs keyframes origen
   - Si no: image-gen-multi estándar
9. Subtítulos: zapcap (si está enabled)
10. VideoGenVeoBlock: animar escenas (si visualEngine='veo-*')
11. compositorRemotion: montar todo en Remotion
12. runQualityGate: validar (render-quality-judge)
    - Gemini ve+oye y audita: anatomy, lipsync, transitions, etc.
    - Si falla: emit editor-loop (3 iters max para proponer fixes)
13. Persistir output.mp4 + metadata
14. logSystemEvent: registrar al KB
```

**Ubicación:** apps/web/lib/pipeline.ts (líneas 129+).

**Parámetros comunes:**
- `brandId`: ID de la marca (idioma, voces, productos)
- `presetId`: ID del preset (promptTemplate, visualEngine, strategy)
- `scriptText`: el guion (ya procesado: adaptado en Ripear, directo en Crear)
- `overrides`: PipelineOverrides (voice, gender, referenceVideoPath, productId, mode, etc.)

**Retorna:** nada (async void), actualiza DB en tiempo real, emite eventos al KB.

---

## Diferencias exactas entre los 3 modos

| Aspecto | CREAR | RIPEAR | APRENDER |
|---------|-------|--------|----------|
| **Entrada** | Guion en texto | Video MP4 | Video MP4 |
| **Preprocessing** | Ninguno | Análisis (Gemini) + Adaptación de guion | Análisis (Claude vision) + Iteración de prompt |
| **Preset** | Elegido por usuario | Dinámico (auto-construido) | Dinámico (auto-aprendido iterativamente) |
| **Guion final** | Directo del usuario | Adaptado por Gemini al producto | N/A (solo preset) |
| **Objetivo** | Generar 1 video | Generar 1 video similar al original | Generar preset reutilizable |
| **Salida video** | Sí | Sí | No (solo preset) |
| **Salida preset** | No | Sí (dinámico) | Sí (aprendido, pending/) |
| **Convergencia** | runPipeline | runPipeline | preset-learning-loop → guarda preset |
| **Duración típica** | 5-10 min | 7-15 min | 2-4 min (APRENDER), luego opcionalmente Crear con el preset |
| **Costo típico** | $0.50-2.00 | $0.80-3.00 | $0.40-1.20 (APRENDER) + normal si se crea video |

---

## Flujos de Análisis

### Gemini (Ripear)

Ubicación: `apps/web/lib/ad-analyzer.ts`

Entrada: videoPath + mimeType (MP4/MOV/WebM ≤200 MB).

Salida: **AdAnalysis** (contract en `@video-factory/contracts`):
```typescript
{
  language: 'es',
  fullNarration: "El guion completo del ad original",
  product: {
    name, visualDescription, mainClaim
  },
  hookType: 'autoridad' | 'testimonio' | 'pain-agitation' | ...,
  editorialLine: "tono + propuesta de valor del original",
  scenes: [{ visualDescription, beat, ... }],
  narratorProfile: {
    gender: 'male' | 'female' | ...,
    ageRange: "30-45",
    ...
  },
  visualStyleProfile: {
    mediaType: 'ugc-real' | 'photo' | 'illustration-2d' | ...,
    dominantPalette: ["#AABBCC", ...],
    lookDescription: "...",
    aestheticTags: [...]
  },
  totalDurationSeconds: 45
}
```

**Detalle:** Envía el video a Gemini (inline si ≤14 MB, File API si >14 MB) con un prompt que le pide analizar narrativa, estilo visual, personaje, etc.

---

### Claude Vision (Aprender)

Ubicación: `apps/web/lib/video-understander.ts`

Entrada: videoPath (ya grabado en disco).

Proceso:
1. `extractKeyframes()` (ffmpeg): extrae N keyframes (default: infer por duración)
2. Cargar frames como imágenes + labels con timestamps
3. Llamar Claude multimodal con SYSTEM_PROMPT que describe qué extraer
4. Claude devuelve **VideoUnderstanding**:
```typescript
{
  styleId: "pixar-3d-sepia",
  styleDescription: "...",
  hookType: 'bold-claim' | 'question' | ...,
  palette: ["#AABBCC", ...],
  character: { gender, ageRange, description },
  productPresentation: { ... },
  scenes: [{ sourceTimeSec, visualDescription, narrativeBeat, ... }],
  compositionDensity: 'minimalist' | 'moderate' | 'dense' | 'very-dense',
  keyVisualComponents: ["elements that make the style rich"],
  suggestedPreset: {
    promptTemplate: "...",
    negativePrompt: "...",
    aspectRatio: '9:16',
    format: 'b-roll-animated' | ...,
    scenesPerMinute: 10,
    visualEngine: 'imagen4' | 'veo-lite' | ...
  },
  executiveSummary: "1-3 oraciones"
}
```

**Detalle:** Busca la "compositionDensity" (minimalist/moderate/dense) y enriquece el prompt si es denso, porque la densidad es crítica para igualar el look.

---

## Mapeo: Análisis → Preset Dinámico

### dynamic-preset-builder.ts (Ripear)

Toma `AdAnalysis` y construye `PresetConfig` automáticamente.

Reglas de inferencia:
- **Category:** Detecta `narrator.gender` + `hookType` → categoría narrativa (doctor_autoridad, mujer_protagonista, etc.)
- **Format:** Si `mediaType='ugc-real'` → `ugc-testimony`. Si `illustration-2d` → `voiceover-animated`. Si duración >180s → `vsl`.
- **VisualEngine:** UGC/photo-real → `imagen4` (sin animación, estático). Illustration → `veo-lite` (animado).
- **PromptTemplate:** Si `visualStyleProfile` presente → usa `lookDescription` directo. Si no → heurístico (regex en visualDescription).
- **NegativePrompt:** Adaptado al mediaType (si real → rechaza illustration; si illustration → rechaza photo).

**Salida:** PresetConfig completo, persistido en `packages/presets/pending/learned-[id].preset.json`.

### auto-learn-preset.ts (Aprender)

Toma `VideoUnderstanding` y construye `PresetConfig` automáticamente.

Diferencias vs dynamic-preset-builder:
- Más detalles del estilo (palette, keyVisualComponents, suggestedPreset del Claude)
- Enriquecimiento de densidad: si `compositionDensity='dense'`, inyecta "DENSE, multi-component" en el prompt
- Embebe keyframe representativo como data-URI en `visualStyle.referenceImages` (para que la generación lo use con Nano Banana)

**Salida:** PresetConfig, persistido en `packages/presets/pending/learned-auto-[uuid].preset.json`.

---

## Integración: UI → Endpoints → Pipeline

### CREAR

```
UI: /create
  ├─ CreateForm (componente)
  │   ├─ Selecciona: brand, preset, script
  │   └─ POST /api/generate
  │
API: POST /api/generate
  ├─ Valida schema
  ├─ INSERT runs (status='pending')
  └─ void runPipeline(runId, ..., { script })
       └─ async → actualiza DB, emite eventos
```

### RIPEAR

```
UI: /rip
  ├─ RipUploader (componente)
  │   └─ POST /api/rip/upload
  │
API: POST /api/rip/upload
  ├─ Guarda video en disco
  ├─ INSERT rips (status='analyzing')
  └─ void analyzeAd() (Gemini background)
       └─ DB update: status='analyzed', analysisJson

UI: /rip/[id]
  ├─ RipDetailView (poll hasta analyzed)
  ├─ Selecciona: brand, product, fidelityMode
  ├─ Botón "Ripear"
  │   └─ Paso 2: POST /api/rip/[id]/build-preset
  │   └─ Paso 3: POST /api/rip/[id]/rip
  │
API: POST /api/rip/[id]/build-preset
  ├─ buildAndPersistDynamicPreset(analysis) → presetId

API: POST /api/rip/[id]/rip
  ├─ ripAd(): Gemini adapta guion (o usa literalScript)
  ├─ INSERT runs (status='pending')
  └─ void runPipeline(runId, ..., {
       referenceVideoPath (si fidelityMode='high'),
       narratorGenderOverride
     })

UI: /runs/[id]
  ├─ Poll hasta completed/failed
  ├─ Ver video + validaciones
```

### APRENDER

```
UI: /rip/[id] (cuando status='analyzed')
  ├─ Botón "🧠 Aprender estilo al 95%"
  │   └─ POST /api/rip/[id]/learn-preset
  │
API: POST /api/rip/[id]/learn-preset
  ├─ runPresetLearningLoop():
  │   ├─ understandVideo() (Claude vision)
  │   ├─ autoLearnPresetFromVideo() (v1)
  │   ├─ Loop (iter 1..maxIterations):
  │   │   ├─ generateImageWithReference() (test image)
  │   │   ├─ compareImagesWithVision() (score)
  │   │   ├─ Si score >= target: APROBAR
  │   │   └─ Si no: refinePromptTemplate() (Claude)
  │   └─ Persistir preset final
  └─ Retorna { presetId, finalScore, approved, ... }

Luego: Usuario puede crear un video con el preset aprendido
  └─ Ir a /create, seleccionar preset aprendido
  └─ Procede como CREAR normal
```

---

## Casos de uso no-obvios

### LiteralScript en Ripear

Si el usuario quiere mantener el guion original EXACTO sin que Gemini lo adapte:

```typescript
POST /api/rip/[id]/rip {
  literalScript: "el guion exacto"
}
```

→ `ripAd()` ignora Gemini, usa ese guion directamente.
→ Útil si el owner conoce bien el original y quiere mantener cada palabra.

### FidelityMode: 'high' vs 'fast' en Ripear

- **'fast'** (default): image-gen-multi estándar (~2-3 min, ~$0.30).
- **'high':** rip-fidelity-aligner loop iterativo vs keyframes del original (~10-15 min, ~$2-3).

Solo disponible si `rip.videoPath` sigue en disco (si no, error 410).

### NarratorGenderOverride

En Ripear y Crear, el usuario puede forzar el género de la voz (override del inferido):

```typescript
narratorGenderOverride: 'male' | 'female'
```

→ Útil si el análisis detectó mal o el user quiere cambiar el género de la narración.

---

## Almacenamiento y persistencia

### Rips (análisis)

- Tabla DB: `rips` (drizzle)
- Campos clave:
  - `id`: ripId (UUID)
  - `videoPath`: ruta absoluta en `storage/rips/[ripId]/source.<ext>`
  - `status`: 'uploaded' | 'analyzing' | 'analyzed' | 'failed'
  - `analysisJson`: AdAnalysis JSON stringified
  - `errorMessage`: si status='failed'

### Presets aprendidos

- Dinámicos (Ripear): `packages/presets/pending/learned-[random].preset.json`
- Auto-aprendidos (Aprender): `packages/presets/pending/learned-auto-[uuid].preset.json`
- Metadatos (Aprender): `learned-auto-[uuid].understanding.json`, `learned-auto-[uuid].iterations.json`

### Runs (videos generados)

- Tabla DB: `runs`
- Campos: id, status, scriptRaw, outputPath, workDir, etc.
- Salida: `storage/outputs/[runId]/output.mp4` (si completed)

---

## Errores comunes y traps

### Trap 1: literalScript vacío o NULO

Si `literalScript=""` o `null`, `ripAd()` lo detecta como "no proporcionado" (`if (opts.literalScript && opts.literalScript.trim())`). → Cae a adaptación con Gemini.

Si el user quiere un literalScript vacío (video sin narración), tiene que ser explícito en el guion (indicar silencio/música).

### Trap 2: narratorGenderOverride no sobreescribe si el análisis es 'neutral'

```typescript
const narratorGenderOverride =
  opts.narratorGenderOverride ??
  (inferredGender === 'male' || inferredGender === 'female' ? inferredGender : null);
```

Si el análisis detectó 'neutral', y el override es `null`, → no force nada. El pipeline elige.

**Gotcha:** Si quieres forzar un gender específico, tenés que pasar explícitamente en el override, no confiars que se infiera.

### Trap 3: Presets "pending" no aparecen en /create hasta que los apruebes

Los presets auto-aprendidos van a `packages/presets/pending/` y necesitan aprobación manual en `/admin` para aparecer en /create como opción visible.

**Gotcha:** El user genera un preset aprendido, pero no lo ve en la lista de /create. Tiene que ir a `/admin` y aprobarlo primero.

### Trap 4: videoPath en DB puede no existir (garbage collection)

Si alguien limpió `storage/rips/` a mano, `rip.videoPath` sigue en DB pero el archivo no existe.

→ Si el user pide `fidelityMode='high'`, fallamos con 410 (Gone).
→ Si pide `fidelityMode='fast'`, funciona (no necesita el video).

**Gotcha:** Es ideal hacer garbage collection de rips antiguos, pero hay que limpiar DB + disco juntos.

### Trap 5: AdAnalysis vs VideoUnderstanding — schemas distintos

- **AdAnalysis** (Gemini): fullNarration, hookType, visualStyleProfile, narratorProfile
- **VideoUnderstanding** (Claude): styleId, compositionDensity, keyVisualComponents, suggestedPreset

Ambos están en contracts, pero los campos no mapean 1-a-1.

**Gotcha:** Si mezclas análisis viejo (sin visualStyleProfile) con código que lo espera, caes a heurísticos de regex (regex fallible).

### Trap 6: Preset learning loop puede agotar iteraciones sin alcanzar target

Si `finalScore < targetScore` pero `exhausted=true`, el usuario sigue teniendo un preset (el mejor visto), pero marcado como incompleto.

**Gotcha:** No asumar que `approved=true` siempre; leer `exhausted` también.

### Trap 7: Mode 'collaborative' pausa el pipeline

Si `mode='collaborative'`, el pipeline pausa entre cada escena esperando `POST /api/runs/[id]/resume` del owner.

**Gotcha:** Si olvidás reanudar, el run queda en `pausedAtSceneIndex` indefinidamente. No es automático.

---

## Estadísticas y costos típicos

| Operación | Costo | Tiempo | Notas |
|-----------|-------|--------|-------|
| Crear video (5 escenas) | $0.50-2.00 | 5-10 min | Incluye TTS, image-gen, validación |
| Ripear rápido (fidelity='fast') | $0.80-3.00 | 7-15 min | Análisis Gemini + generación |
| Ripear fidelidad alta (fidelity='high') | $1.50-5.00 | 20-30 min | Loop iterativo por escena |
| Aprender preset (4 iters, 95%) | $0.40-1.20 | 2-4 min | Understander + 4 loops image-compare-refine |
| Entender video (video-understander) | $0.02-0.06 | 10-25 s | Claude multimodal sobre 5-9 keyframes |

---

## Integration points con otros subsistemas

1. **Brand loader:** Carga marca + idioma + voces. Usado en todos los 3 modos.
2. **Preset loader:** Carga preset (estático) o dinámico. Usado en todos los 3 modos.
3. **Pipeline central:** La orquestación. Usado en CREAR y RIPEAR.
4. **Quality gate (render-quality-judge):** Valida el output final. Post-pipeline.
5. **System log (M9):** Registra eventos (run-completed, preset-created). Alimenta KB.
6. **KB (Knowledge Base):** Recibe eventos del system-log. Usado en Consejo de mejora.

**⚠️ Gotchas (02-modos-crear-ripear-aprender):**
- literalScript en Ripear es sensible: '' (vacío) dispara adaptación con Gemini. Solo null/undefined + trim() = no proporcionado.
- narratorGenderOverride no fuerza nada si el análisis devuelve 'neutral'; el user tiene que pasar explícitamente el override si quiere cambiar.
- Presets aprendidos en packages/presets/pending/ no aparecen en /create hasta aprobación manual en /admin. El user no los ve automáticamente.
- videoPath en DB de rips puede apuntar a archivos borrados. fidelityMode='high' falla con 410 (Gone) si el video no existe; fidelityMode='fast' sigue funcionando.
- AdAnalysis (Gemini) != VideoUnderstanding (Claude): campos distintos. dynamic-preset-builder usa AdAnalysis; auto-learn-preset usa VideoUnderstanding.
- Preset learning loop puede agotar iteraciones sin alcanzar targetScore: devuelve preset mejor-visto marcado exhausted=true, NO necesariamente aprobado.
- Mode 'collaborative' pausa pipeline entre escenas: requiere POST /api/runs/[id]/resume explícito del owner. Sin resumar, queda pausado indefinidamente.
- compositionDensity es CRÍTICO: si el estilo es 'dense', el prompt tiene que pedir 'DENSE, multi-component' explícitamente, o la escena nace minimalista.
- referenceImages en preset (embedde como data-URI en auto-learn-preset) se usa con Nano Banana en image-gen para anclar estilo + densidad.
- fidelityMode='high' requiere que rip.videoPath exista Y sea accesible (ffmpeg extrae keyframes). Si falla, el ripeo completo falla.


---

# Subsistema 03: Guion, Voz y TTS (Text-to-Speech)

## Propósito general

Este subsistema transforma un **guion en texto crudo** (entrada del usuario) en **audio narrado sincronizado** (pista de voz del video). Funciona en la fase B del pipeline (scripts B.1–B.3) y alimenta tanto el timing de escenas como la pista de audio final del compositor.

Pasos:
1. **B.1: script-processor** — normaliza el texto, divide en segmentos por puntuación, estima duración
2. **B.1.5: narrator-analyzer** — infiere perfil del narrador (género, edad, caracterización visual) con Gemini 2.5 Pro
3. **B.2: TTS (Text-to-Speech)** — genera audio mp3:
   - Primario: **ElevenLabs** (mejor calidad, sintaxis con pausas `<break>` y voice settings)
   - Fallback automático: **OpenAI TTS** (si ElevenLabs falla por quota, auth o red)
4. **B.3: word-sync** — obtiene timestamps por palabra usando el endpoint `/with-timestamps` de ElevenLabs, detecta enumeraciones ("A, B y C") y planifica micro-escenas sincronizadas

**Invariante crítico** (CLAUDE.md): Español neutro SIEMPRE — el pipeline normaliza voseo/regionalismos ANTES del TTS, de modo que audio, subtítulos y escenas usen forma con "tú".

---

## Arquitectura end-to-end

### 1. Script Processor (`packages/blocks/script-processor`)

**Archivo:** `packages/blocks/script-processor/src/parser.ts`

**Responsabilidad:** Parsea texto bruto en `ParsedScript` (estructura con segmentos, pauses, duración estimada).

```typescript
// Entrada: ScriptInput
{
  rawText: string,
  language: string (default 'es')
}

// Salida: ParsedScript
{
  language: string,
  segments: ScriptSegment[],
  estimatedDurationSeconds: number,
  narratorProfile?: NarratorProfile,  // opcional, poblado por narrator-analyzer
  speakers?: SpeakerProfile[]          // multi-voz (futuro, no emitido aún)
}
```

**Lógica:**
- Normaliza espacios (unicode no-breaking space → espacio normal, collapse múltiples espacios)
- **Divide por puntuación** (regex lookbehind): `/(?<=[.?!…])\s+/` → preserva el signo en el segmento anterior
- **Calcula pauses** (regla hard-coded, `packages/blocks/script-processor/src/parser.ts:5-11`):
  - `…` (ellipsis U+2026) → 300 ms
  - `.` (period) → 200 ms
  - `?` (question) → 200 ms
  - `!` (exclamation) → 200 ms
  - sin signo → 0 ms
- **Cuenta palabras** (limpia puntuación, split por espacios, descarta vacíos) para estimar duración
- **Duración estimada:** `totalWords / DEFAULT_WORDS_PER_SECOND (2.5) + sumaPauses / 1000`

**Archivos clave:**
- `packages/blocks/script-processor/src/parser.ts:18–79` — función `parseScript()`

---

### 2. Narrator Analyzer (`packages/blocks/narrator-analyzer`)

**Archivo:** `packages/blocks/narrator-analyzer/src/block.ts`

**Responsabilidad:** Analiza el `ParsedScript` con **Gemini 2.5 Pro** para inferir el perfil del narrador (gender, edad, character card visual). Poblamos el campo `narratorProfile` del script para que TTS y scene-planner lo usen.

**Flujo:**
1. Si el `ParsedScript` ya viene con `narratorProfile.narratorPresent` definido (override del UI), **lo respeta** y no re-analiza
2. Si no hay `GOOGLE_AI_API_KEY`, devuelve **perfil neutro** (narratorPresent=false) sin error → fallback seguro
3. Si falla la llamada a Gemini (error de red, quota, etc.), **devuelve perfil neutro** sin bloquear el pipeline
4. Si tiene apiKey, llama a `GeminiClient.generateJson()` con el prompt:

```
GUION A ANALIZAR:
{rawScript}

Devuelve JSON con shape exacto:
{
  "narratorPresent": true | false,
  "gender": "male" | "female" | "neutral",
  "ageRange": "20-30" (ej),
  "characterCard": "<35-60 palabras describiendo VISUALMENTE al narrador>"
}
```

**System instruction clave** (`packages/blocks/narrator-analyzer/src/block.ts:12–26`):
- `narratorPresent=true` **SOLO** si el guion identifica explícitamente al hablante ("Soy Dr. X", "Como experta en Z", pronombres de género)
- `narratorPresent=false` si es voiceover impersonal sin gender claro
- Gender se infiere de: nombre propio (ej. "Hiroshi" → male, "María" → female), título ("doctor" vs "doctora"), pronombres
- `characterCard` es VISUAL y usable por ilustradores: edad, etnia, peinado, vestimenta, expresión, ambiente típico

**Archivos clave:**
- `packages/blocks/narrator-analyzer/src/block.ts:45–138` — clase `NarratorAnalyzerBlock`

---

### 3. TTS: ElevenLabs (Primario)

**Archivos:** 
- `packages/blocks/tts-elevenlabs/src/block.ts` — bloque TTS
- `packages/blocks/tts-elevenlabs/src/voice-selector.ts` — **FIX CRÍTICO** para selección de voz por gender
- `packages/blocks/tts-elevenlabs/src/client.ts` — cliente HTTP
- `packages/blocks/tts-elevenlabs/src/timing.ts` — construcción de prompt con pausas

#### 3.1 Voice Selector (`voice-selector.ts`)

**POR QUÉ existe:** Antes, el pipeline **siempre usaba `brand.defaultVoice`**, ignorando el género del narrador inferido. Resultado: un narrador HOMBRE salía con voz FEMENINA (ej. BioZentra/Vitaly defaultVoice = female), y la cache reciclaba ese audio incorrecto (`ttsCacheKeyFromScript` usaba solo el voiceId).

**SOLUCIÓN** (implementada en `packages/blocks/tts-elevenlabs/src/voice-selector.ts:27–85`):

```typescript
function selectVoiceForNarrator(opts: SelectVoiceOptions): ElevenLabsVoiceConfig {
  // 1. Si NO hay narratorProfile O narratorPresent=false:
  //    → devuelve defaultVoice (voiceover genérico de la marca)
  if (!narratorProfile || !narratorProfile.narratorPresent) {
    logger?.info({...}, 'voice-selector:using_default');
    return defaultVoice;
  }

  // 2. Si narratorProfile.gender MATCHEA defaultVoice.gender O gender='neutral':
  //    → devuelve defaultVoice (sin buscar en library)
  if (narratorProfile.gender === defaultVoice.gender || narratorProfile.gender === 'neutral') {
    logger?.info({...}, 'voice-selector:using_default');
    return defaultVoice;
  }

  // 3. Si NO MATCHEA: busca en voiceLibrary voces del MISMO gender del narrador
  const candidates = voiceLibrary.filter((v) => v.gender === narratorProfile.gender);
  if (candidates.length === 0) {
    // Sin candidatos: fallback a defaultVoice con WARNING
    logger?.warn({...}, 'voice-selector:no_match_falling_back_to_default');
    return defaultVoice;
  }

  // 4. Match más cercano por edad:
  //    - parsea ageRange como "min-max" (ej. "45-60")
  //    - calcula punto medio (mid)
  //    - elige el candidato con distancia mínima entre midpoints
  const targetMid = ageRangeMidpoint(narratorProfile.ageRange);
  const scored = candidates
    .map((v) => ({ voice: v, dist: Math.abs(ageRangeMidpoint(v.ageRange) - targetMid) }))
    .sort((a, b) => a.dist - b.dist);
  const chosen = scored[0]!.voice;

  logger?.info({...chosen..., reason: 'matched-library-voice'}, 'voice-selector:using_library_match');
  return chosen;
}
```

**Dónde se llama:**

1. **En el bloque TTS** (`packages/blocks/tts-elevenlabs/src/block.ts:62–68`):
   ```typescript
   const voice = selectVoiceForNarrator({
     defaultVoice: ctx.brand.defaultVoice,
     voiceLibrary: ctx.brand.voiceLibrary ?? [],
     narratorProfile: input.narratorProfile,
     logger: ctx.logger,
     runId: ctx.runId,
   });
   ```

2. **En el pipeline** (`apps/web/lib/pipeline.ts:239–259`):
   - TRAS narrator-analyzer, ANTES de cache key y síntesis
   - Si NO hay `voiceOverride` explícito (UI) Y hay `narratorProfile`:
     ```typescript
     const selectedVoice = selectVoiceForNarrator({...});
     if (selectedVoice.voiceId !== brand.defaultVoice.voiceId) {
       brand = { ...brand, defaultVoice: selectedVoice };
       logger.info({...}, 'pipeline:voice_selected_by_gender');
     }
     ```

**Archivos clave:**
- `packages/blocks/tts-elevenlabs/src/voice-selector.ts:27–92` — función `selectVoiceForNarrator()`
- `apps/web/lib/pipeline.ts:239–259` — aplicación en pipeline

#### 3.2 Síntesis ElevenLabs: Prompt + Voice Settings

**Flujo en `TtsElevenLabsBlock.run()`** (`packages/blocks/tts-elevenlabs/src/block.ts:34–133`):

1. **buildPrompt()** (`packages/blocks/tts-elevenlabs/src/timing.ts:3–13`):
   - Une segmentos con **`<break time="Xms"/>`** entre ellos (sintaxis ElevenLabs)
   - Último segmento NO lleva break (incluso si tiene pauseAfterMs > 0)
   - Ejemplo: `"Hola. <break time="200ms"/> Mundo… <break time="300ms"/> Adiós."`

2. **Síntesis en ElevenLabs**:
   ```typescript
   const audioBuffer = await client.synthesize({
     voiceId: voice.voiceId,              // voz elegida por gender
     modelId: voice.modelId,               // "eleven_multilingual_v2"
     text: prompt,                         // con <break/> insertados
     voiceSettings: {
       stability: voice.stability,         // 0.0–1.0 (default 0.5)
       similarity_boost: voice.similarity, // 0.0–1.0 (mejora consistencia)
       style: voice.style,                 // 0.0–1.0 (exageración emocional)
       use_speaker_boost: voice.speakerBoost, // boolean
     },
   });
   ```

3. **Guardar audio:**
   - Ruta: `${ctx.workDir}/audio.mp3`
   - Duración: estimada desde `input.estimatedDurationSeconds` (del parser)

4. **Computar timings de segmentos** (`computeSegmentTimings()`, `timing.ts:18–42`):
   - Distribuye la duración **total** entre segmentos **proporcionalmente** al largo en caracteres
   - Cada segmento N tiene `startTime` = duración anterior, `endTime` = start + (chars / total * duracion)
   - **Fuerza** el `endTime` del último segmento = duración total (evita drift por redondeo)
   - Retorna `AudioSegment[]` con fields: `text`, `startTimeSeconds`, `endTimeSeconds`

**Archivos clave:**
- `packages/blocks/tts-elevenlabs/src/block.ts:34–133` — clase `TtsElevenLabsBlock`
- `packages/blocks/tts-elevenlabs/src/timing.ts` — buildPrompt, computeSegmentTimings
- `packages/blocks/tts-elevenlabs/src/client.ts:46–77` — método `synthesize()`

---

### 4. TTS: OpenAI (Fallback automático)

**Archivo:** `packages/blocks/tts-openai/src/block.ts`

**Cuándo se activa:**
- Si ElevenLabs falla por **cualquier razón** (quota/auth/timeout/red)
- Runable de forma independiente (también se puede forzar manualmente)

**Voces y mapeo a gender** (`packages/blocks/tts-openai/src/block.ts:31–35`):
```typescript
const GENDER_TO_VOICE: Record<'male' | 'female' | 'neutral', OpenaiVoice> = {
  male: 'onyx',        // deep autoritativo → ideal para "doctor"
  female: 'nova',      // young energetic
  neutral: 'alloy',    // neutro
};
```

**Flujo** (`packages/blocks/tts-openai/src/block.ts:64–169`):

1. Valida `OPENAI_API_KEY` (no placeholder, no vacía)
2. Elige voz según `narratorProfile?.gender ?? 'neutral'`
3. Concatena segmentos con `\n\n` (double newline = pausa natural más larga)
4. Llama `POST https://api.openai.com/v1/audio/speech`:
   ```json
   {
     "model": "tts-1" (default, más barato) o "tts-1-hd",
     "input": text,
     "voice": "onyx|nova|alloy",
     "response_format": "mp3",
     "speed": 1.0 (default)
   }
   ```
5. Guarda audio en `${ctx.workDir}/audio.mp3`
6. **Estima duración** (OpenAI no devuelve): `text.length / 15 / speed` (15 chars/s en español ≈ 150 wpm)
7. Distribuye timing de segmentos linealmente (no proporcional a caracteres como ElevenLabs)

**Notas:**
- OpenAI TTS **no soporta SSML** ni `<break>`, por eso distribuimos pauses con double newlines
- Más barato que ElevenLabs (~$0.015/1M chars vs. $0.30/1M chars)
- Calidad visual (naturalidad) inferior, pero funcional como fallback

**Archivos clave:**
- `packages/blocks/tts-openai/src/block.ts:50–169` — clase `TtsOpenaiBlock`

---

### 5. Pipeline: Cache + Fallback + Voice Selection

**Archivo:** `apps/web/lib/pipeline.ts`

**Flujo completo B.2** (lines 223–370):

1. **Voice Selection** (si NO hay `voiceOverride`):
   - Llama `selectVoiceForNarrator()` con `narratorProfile` inferido
   - Si la voz elegida ≠ defaultVoice, actualiza `brand.defaultVoice`
   - Registra en logs: `'pipeline:voice_selected_by_gender'`

2. **Cache hit check** (`checkTtsCache(elevenlabsCacheKey)`):
   - Key: `ttsCacheKeyFromScript(parsedScript, voiceId, modelId, speedMultiplier, 'elevenlabs')`
   - Si existe: copia audio desde `storage/tts-cache/` a `workDir/audio.mp3`
   - Probed duration con `getVideoDurationSec()` (usa ffmpeg bundled de Remotion)
   - Fallback: estima desde texto (~15 chars/s ES)

3. **ElevenLabs síntesis** (si cache miss):
   - Bloque `TtsElevenLabsBlock.run()`
   - Si error: registra cause (quota/auth vs. otro), entra fallback

4. **Fallback a OpenAI** (si ElevenLabs falla):
   - Cache key distinto (provider distinto)
   - Check hit (si cached alguna vez)
   - Síntesis con `TtsOpenaiBlock.run()`
   - Si ambos fallan: error bloqueante, run falla

5. **Save to cache** (si fresh generation):
   - Copia audio a `storage/tts-cache/{cache-key}.mp3`

**Archivos clave:**
- `apps/web/lib/pipeline.ts:215–259` — Spanish normalization + voice selection
- `apps/web/lib/pipeline.ts:223–370` — flujo TTS + cache + fallback
- `apps/web/lib/tts-cache.ts` — funciones checkTtsCache, copyFromCache, saveToCache

---

### 6. Word Synchronization y Micro-escenas (`packages/blocks/word-sync`)

**Responsabilidad:** Obtiene timestamps **por palabra** (no por segmento) usando ElevenLabs `/with-timestamps`, detecta **enumeraciones** ("A, B y C") y planifica ventanas temporales (`MicroScene`) para cortar visuales sincronizados a cada palabra.

#### 6.1 Fetch Word Timings

**Archivo:** `packages/blocks/word-sync/src/elevenlabs-timings.ts`

```typescript
async function fetchWordTimings(opts: FetchWordTimingsOptions): Promise<WordTimingsResult> {
  // POST /v1/text-to-speech/{voiceId}/with-timestamps
  const data = await f(`${base}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, {
    method: 'POST',
    headers: {
      'xi-api-key': opts.apiKey,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: opts.modelId ?? 'eleven_multilingual_v2',
      voice_settings: opts.voiceSettings,
    }),
  });

  // Respuesta:
  // {
  //   "audio_base64": "...",
  //   "alignment": {
  //     "characters": ["H", "o", "l", "a", ...],
  //     "character_start_times_seconds": [0.0, 0.05, 0.1, ...],
  //     "character_end_times_seconds": [0.05, 0.1, 0.15, ...]
  //   }
  // }
  
  const alignment = data.alignment ?? data.normalized_alignment;
  return {
    audio: Buffer.from(data.audio_base64, 'base64'),
    words: tokenizeFromAlignment(alignment),  // reconstruct word timings
    alignment,
  };
}
```

**Flujo:**
1. Usa el **mismo prompt + voice settings** que la síntesis anterior
2. Devuelve `alignment` a nivel **carácter** (tiempos de inicio/fin de cada char)
3. `tokenizeFromAlignment()` reconstruye palabras: acumula caracteres hasta espacio, usa char timings para word timings

#### 6.2 Tokenize from Alignment

**Archivo:** `packages/blocks/word-sync/src/micro-scenes.ts:35–60`

```typescript
function tokenizeFromAlignment(al: CharAlignment): WordTiming[] {
  // Recorre la alineación por carácter, agrupa por espacios.
  // Cada palabra = caracteres continuos sin espacio.
  // start = start del primer char, end = end del último char.
  const words: WordTiming[] = [];
  let cur = '';
  let wStart: number | null = null;
  let wLastEnd = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === ' ' || c === '\n' || c === '\t') {
      if (cur) {
        words.push({ word: cur, start: round(wStart), end: round(wLastEnd) });
        cur = '';
        wStart = null;
      }
    } else {
      if (wStart === null) wStart = st[i];
      cur += c;
      wLastEnd = en[i];
    }
  }
  if (cur) words.push({ word: cur, start: round(wStart), end: round(wLastEnd) });
  return words;
}
```

#### 6.3 Enumeration Detection

**Archivo:** `packages/blocks/word-sync/src/micro-scenes.ts:130–174`

**Idea:** Detecta patrones de **enumeración** ("recorre tu cara, tu abdomen y tus piernas"):

1. **splitSegments()**: divide stream de palabras en segmentos por comas, conectores ("y", "e", "o", "u") y puntuación final
2. **toItem()**: convierte cada segmento en un ítem si cumple criterios:
   - Recorta lead-in verbal (ej. "recorre") hasta el primer artículo
   - El sustantivo final (palabra última) es el "anchor" (palabra clave para microscene)
   - Retorna `EnumItem: { phrase, anchor, start, end, hadArticle, singleWord, leadInWords }`
3. **Validación de paralelismo**: todos los ítems deben ser **homogéneos**:
   - Todos arrancan con artículo ("tu cara", "tu abdomen", "tus piernas") OR
   - Todos son sustantivos pelados (sin artículo)
   - AND no hay anchors duplicados (cada ítem distinto)
4. **Si ≥ minItems** (default 2) + conector/coma + paralelismo: es una enumeración válida

```typescript
function detectEnumerations(words: WordTiming[], opts: DetectOptions = {}): Enumeration[] {
  const segs = splitSegments(words);  // divide por comas y conectores
  const enums: Enumeration[] = [];
  let run: Segment[] = [];

  const flush = () => {
    if (run.length >= minItems) {
      const items = run.map((s) => toItem(s, maxWords));
      if (items.every((it): it is EnumItem => it !== null)) {
        const valid = items as EnumItem[];
        const allArticle = valid.every((it) => it.hadArticle);
        const allSingle = valid.every((it) => it.singleWord);
        const anchors = new Set(valid.map((it) => it.anchor));
        if ((allArticle || allSingle) && anchors.size === valid.length) {
          enums.push({
            items: valid,
            start: valid[0]!.start,
            end: valid[valid.length - 1]!.end,
          });
        }
      }
    }
    run = [];
  };

  for (const seg of segs) {
    run.push(seg);
    if (seg.sepAfter === 'end') flush();
  }
  return enums;
}
```

#### 6.4 Plan Micro-scenes

**Archivo:** `packages/blocks/word-sync/src/micro-scenes.ts:176–198`

```typescript
function planMicroScenes(words: WordTiming[], opts: DetectOptions = {}): MicroScene[] {
  const enums = detectEnumerations(words, opts);
  const scenes: MicroScene[] = [];

  for (const e of enums) {
    for (let i = 0; i < e.items.length; i++) {
      const it = e.items[i]!;
      // end = start del siguiente ítem (para corte exacto), o end del ítem si es el último
      const end = i < e.items.length - 1 ? e.items[i + 1]!.start : it.end;
      scenes.push({
        item: it.phrase,
        anchor: it.anchor,
        start: round(it.start),
        end: round(end),
        enumerationStart: round(e.start),
      });
    }
  }
  return scenes;
}
```

**Resultado:** cada ítem → micro-escena con ventana `[start, end)`:
- Ejemplo: "recorre tu cara, tu abdomen y tus piernas" con timings word-level
  - Micro-scene 1: "cara", start=0.5s, end=0.8s (hasta "abdomen")
  - Micro-scene 2: "abdomen", start=0.8s, end=1.2s (hasta "piernas")
  - Micro-scene 3: "piernas", start=1.2s, end=1.6s (final del utterance)

**Archivos clave:**
- `packages/blocks/word-sync/src/elevenlabs-timings.ts:28–60` — fetchWordTimings
- `packages/blocks/word-sync/src/micro-scenes.ts:35–60` — tokenizeFromAlignment
- `packages/blocks/word-sync/src/micro-scenes.ts:130–174` — detectEnumerations
- `packages/blocks/word-sync/src/micro-scenes.ts:176–198` — planMicroScenes
- `packages/blocks/word-sync/src/types.ts` — tipos WordTiming, Enumeration, MicroScene

---

## Español Neutro: Corrección y Detección

**Archivo:** `apps/web/lib/neutral-es.ts`

**Invariante crítica** (CLAUDE.md): Todo texto que llegue a TTS debe estar en **español neutro con "tú"**, NUNCA voseo argentino.

### Diseño: Lookup Conservador

Mapa `VOSEO_MAP` (`neutral-es.ts:14–29`):
- **Inequívoco:** solo formas que NO existen en español neutro
- **Lookup exacto:** por palabra completa, case-insensitive
- **Quedan fuera a propósito:** "sos" (puede ser sigla SOS), y imperativos voseo sin tilde homógrafos del pretérito ("salí", "sentí", "descubrí" sin contexto)

```typescript
const VOSEO_MAP: Record<string, string> = {
  // Imperativos voseo (acentuados)
  mirá: 'mira', hacé: 'haz', vení: 'ven', andá: 'anda', poné: 'pon', // ...
  // Presente indicativo 2ª persona voseo (-ás/-és/-ís acentuado)
  tenés: 'tienes', querés: 'quieres', podés: 'puedes', hacés: 'haces', // ...
  // Adverbio regional
  acá: 'aquí',
};
```

### Funciones

**`toNeutralSpanish(text: string): string`** (`neutral-es.ts:41–46`)
- Busca palabras completas (regex `/[A-Za-zÁÉÍÓÚáéíóúñÑ]+/g`)
- Si palabra en minúscula está en `VOSEO_MAP`, reemplaza preservando mayúscula inicial
- Ejemplo: "Mirá" → "Mira", "acá" → "aquí"

**`detectVoseo(text: string): string[]`** (`neutral-es.ts:50–57`)
- Devuelve Set de formas voseo encontradas (sin repetir, minúsculas)
- Usado por la compuerta de calidad: si detecta voseo, video NO es neutro (fallo bloqueante)

### Integración en pipeline

**`apps/web/lib/pipeline.ts:215–221`**:
```typescript
// Español neutro OBLIGATORIO en el guion narrado ANTES de TTS
parsedScript = {
  ...parsedScript,
  segments: parsedScript.segments.map((s) => 
    ({ ...s, text: toNeutralSpanish(s.text) })
  ),
};
```

**Dónde se aplica:** el audio, subtítulos y escenas (todos leen `parsedScript.segments[].text`) quedan en neutro.

**Archivos clave:**
- `apps/web/lib/neutral-es.ts` — toNeutralSpanish, detectVoseo, VOSEO_MAP
- `apps/web/lib/pipeline.ts:215–221` — aplicación en pipeline

---

## Data Structures (Contracts)

**Archivo:** `packages/contracts/src/script.schema.ts`

```typescript
// Entrada del usuario
ScriptInput {
  rawText: string (min 10 chars)
  language: string (default 'es')
}

// Salida de script-processor
ScriptSegment {
  text: string,
  pauseAfterMs: number (0–300),
  emphasisWords: string[] (default []),
}

ParsedScript {
  language: string,
  segments: ScriptSegment[],
  estimatedDurationSeconds: number,
  narratorProfile?: NarratorProfile,   // poblado por narrator-analyzer
  speakers?: SpeakerProfile[],         // multi-voz (futuro)
}

// Perfil del narrador inferido
NarratorProfile {
  gender: "male" | "female" | "neutral",
  ageRange: string (ej. "40-55"),
  characterCard: string (descripción visual),
  narratorPresent: boolean,
}

// Salida de TTS
AudioTrack {
  filePath: string (path a audio.mp3),
  durationSeconds: number,
  sampleRate: number (44100),
  channels: 1,
  format: "mp3",
  segments: AudioSegment[],  // timing por segmento original
}

AudioSegment {
  text: string,
  startTimeSeconds: number,
  endTimeSeconds: number,
}

// Voice library en brand config
ElevenLabsVoiceConfig {
  voiceId: string (ID ElevenLabs),
  modelId: string (default "eleven_multilingual_v2"),
  stability: number (0–1),
  similarity: number (0–1),
  style: number (0–1),
  speakerBoost: boolean (default true),
  speedMultiplier: number (default 1.0),
  gender: "male" | "female" | "neutral",
  ageRange: string (ej. "45-60"),
  label: string (legible, ej. "George · Voz masculina autoritativa"),
}

BrandConfig {
  id: string,
  displayName: string,
  defaultVoice: ElevenLabsVoiceConfig,
  voiceLibrary: ElevenLabsVoiceConfig[] (default []),
  // ... otros campos
}
```

**Archivos clave:**
- `packages/contracts/src/script.schema.ts` — ParsedScript, NarratorProfile
- `packages/contracts/src/audio.schema.ts` — AudioTrack, AudioSegment
- `packages/contracts/src/brand.schema.ts` — ElevenLabsVoiceConfig, BrandConfig

---

## Ejemplo Real: Vitaly + Doctor Hiroshi

**Configuración en `packages/brands/vitaly.brand.json`:**
```json
{
  "defaultVoice": {
    "voiceId": "hpp4J3VqNfWAUOO0d1Us",
    "gender": "female",
    "label": "Vitaly · Amiga chismosa (femenino, 30-45)"
  },
  "voiceLibrary": [
    {
      "voiceId": "JBFqnCBsd6RMkjVDRZzb",
      "gender": "male",
      "ageRange": "45-60",
      "label": "George · Voz masculina madura autoritativa (45-60)"
    },
    {
      "voiceId": "onwK4e9ZLuTAKqWW03F9",
      "gender": "male",
      "ageRange": "30-45",
      "label": "Daniel · Voz masculina cálida adulta (30-45)"
    }
  ]
}
```

**Guion:** "Soy el Dr. Hiroshi Tanaka. Me especializo en envejecimiento anti-reversible..."

**Pipeline:**

1. **script-processor**: ParsedScript con 3 segmentos (period pauses)
2. **narrator-analyzer** (Gemini 2.5 Pro):
   - `narratorPresent: true` (dice "Soy el Dr. Hiroshi Tanaka")
   - `gender: "male"` (título "Doctor", nombre Hiroshi)
   - `ageRange: "50-65"` (inferido de contexto, especialización)
   - `characterCard: "Mature Asian man (Japanese) around 55-60, shaved head with white sideburns, wearing traditional ochre robes or modern doctor's coat, calm and authoritative expression, typically in a Kyoto temple or minimalist clinic setting..."`
3. **Español neutro**: normaliza voseo si hay (ej. "sos" → "eres" — aunque sos no cambia porque es ambiguo)
4. **Voice selection** (`selectVoiceForNarrator`):
   - `defaultVoice.gender = "female"`, `narratorProfile.gender = "male"` → NO MATCHEA
   - Busca en `voiceLibrary` voces con `gender: "male"`:
     - Candidatos: George (45-60, dist=0), Daniel (30-45, dist=10)
   - Elige **George** (menor distancia de edad)
   - Actualiza `brand.defaultVoice` → George
5. **TTS ElevenLabs**:
   - Voice: George (voiceId: JBFqnCBsd6RMkjVDRZzb)
   - Text: "Soy el Dr. Hiroshi Tanaka. <break time=\"200ms\"/> Me especializo en envejecimiento anti-reversible..."
   - Resultado: audio con voz MASCULINA, voz de autoridad
6. **Cache key**: `ttsCacheKeyFromScript(..., "JBFqnCBsd6RMkjVDRZzb", ...)`
   - Diferente de la voz default femenina → no usa audio anterior incorrecto
7. **Word sync** (si `wordSync: true`):
   - Fetch `/with-timestamps` con George + same text
   - Detecta enumeraciones (ej. "cura la inflamación, reduce la hinchazón y mejora la elasticidad")
   - Planifica micro-escenas por cada anchor

**Resultado:** Doctor con voz de hombre mayor/autoritario, coherente con la visualidad.

---

## Wiring Crítico (Evitar Errores)

### 1. Voice Selection debe corer ANTES de Cache Key

**Pipeline** (`apps/web/lib/pipeline.ts:239–268`):

```typescript
// ORDEN CORRECTO:
// 1. selectVoiceForNarrator() (si no override)
// 2. actualizar brand.defaultVoice
// 3. ttsCacheKeyFromScript() usa el voiceId actualizado
// 4. checkTtsCache() + síntesis

if (!overrides.voiceOverride && parsedScript.narratorProfile) {
  const selectedVoice = selectVoiceForNarrator({...});
  if (selectedVoice.voiceId !== brand.defaultVoice.voiceId) {
    brand = { ...brand, defaultVoice: selectedVoice };
  }
}
const elevenlabsCacheKey = ttsCacheKeyFromScript(
  parsedScript,
  brand.defaultVoice.voiceId,  // ← voz YA SELECCIONADA
  ...
);
```

**Si NO lo haces:** un narrador macho seguirá usando audio de la voz femenina default (bug previo).

### 2. Narrador Analyzer ANTES de TTS

**Pipeline** (`apps/web/lib/pipeline.ts:187–213`):
```typescript
// B.1.5
const narratorResult = await narratorAnalyzer.run(parsedScript, ctx);
parsedScript = narratorResult.value;

// B.2 — TTS usa narratorProfile de parsedScript
const voice = selectVoiceForNarrator({
  narratorProfile: input.narratorProfile,  // ← viene de narrator-analyzer
  ...
});
```

**Si NO lo haces:** narratorProfile estará vacío/undefined → voice selector caerá a defaultVoice siempre.

### 3. Español Neutro ANTES de TTS

**Pipeline** (`apps/web/lib/pipeline.ts:215–221`):
```typescript
parsedScript = {
  ...parsedScript,
  segments: parsedScript.segments.map((s) => 
    ({ ...s, text: toNeutralSpanish(s.text) })
  ),
};
// LUEGO: TTS, word-sync, etc. usan el texto normalizado
```

**Si NO lo haces:** audio, subtítulos y escenas quedarán con voseo (regla dura del owner = bloquea).

### 4. Word Sync: Usa MISMO PROMPT + VOICE SETTINGS que síntesis

**Concepto:**

```typescript
// Síntesis:
const audioBuffer = await client.synthesize({
  text: prompt,
  voiceId, modelId, voiceSettings,
});

// Word timings: DEBEN usar MISMO text, voiceId, modelId, voiceSettings
const { audio, words } = await fetchWordTimings({
  text: prompt,  // ← IGUAL
  voiceId,       // ← IGUAL
  voiceSettings, // ← IGUAL
});
```

**Por qué:** El endpoint `/with-timestamps` devuelve alineación para ESA síntesis concreta. Si cambias el texto o voz, los timings serán incorrectos.

### 5. AudioTrack: Duración debe ser real (no estimada)

**Problema anterior** (`apps/web/lib/pipeline.ts` comentario B.3 #142):
- Usaba `ffprobe` crudo (no en PATH) → fallaba → defaulteaba a 60s
- Escenas de 6-11s imposibles

**Solución:**
```typescript
const probedDuration = await getVideoDurationSec(audioPath);  // ffmpeg bundled de Remotion
const estChars = parsedScript.segments.map((s) => s.text).join(' ').length;
const realDuration = 
  probedDuration && probedDuration > 0.5
    ? probedDuration
    : Math.max(3, estChars / 15);  // fallback: 15 chars/s en ES
```

---

## Subtítulos: Desactivados

**Invariante crítica** (CLAUDE.md): "No poner subtítulos salvo que el usuario los pida".

**Estado actual:**
- Bloque `subtitlesGoogle` existe (`packages/blocks/subtitles-google`) pero NO se emite en el pipeline normal
- ZapCap (subtítulos automáticos) existe pero solo si `overrides.subtitlesZapcap === true` o preset lo activa

**Dónde está el código:**
- `apps/web/lib/pipeline.ts:600–620` (sección "Cap 5: Subtítulos")
- `apps/web/lib/zapcap.ts` (integración ZapCap)
- `packages/blocks/subtitles-google/src/block.ts`

---

## Multi-voz (speakerId): No Emitido Aún

**Estado:** Campo `speakerId` YA EXISTE en arquitectura (`packages/contracts/src/scene.schema.ts`), pero el pipeline **no lo emite**.

**Qué falta:**
1. **Narrator analyzer extendido:** detectar múltiples hablantes + roles (authority, user, voiceover)
2. **Speaker router:** asignar voiceId a cada speaker según role/gender/age
3. **Audio segmentation:** dividir pista de audio por speaker, sincronizar cada tramo
4. **Compositor aware:** reproducir audio correcto por speaker para lip-sync

**Para cerrar:** Ver `ARQUITECTURA.md` sección "Estilo CapCut: multi-voz", y `packages/contracts/src/script.schema.ts:43–57` (SpeakerProfile).

---

## Enum Default Values

- `scriptProcessor`: DEFAULT_WORDS_PER_SECOND = 2.5, PAUSE_MS = { ellipsis: 300, period: 200, question: 200, exclamation: 200, none: 0 }
- `narratorAnalyzer`: DEFAULT_MODEL = 'gemini-2.5-pro'
- `ttsElevenLabs`: model_id = 'eleven_multilingual_v2'
- `ttsOpenai`: model = 'tts-1' (más barato), voice = depends on gender (onyx/nova/alloy)
- `wordSync`: minItems = 2, maxWordsPerItem = 3 (para detectar enumeraciones válidas)

---

## Resumen Ejecutivo

El subsistema guion-voz-tts transforma texto crudo → audio narrado sincronizado, con:

1. **Normalización robusta:** script-processor divide por puntuación, estima duración
2. **Perfil del narrador:** narrator-analyzer (Gemini) infiere gender, edad, visual
3. **Voice selection inteligente:** selectVoiceForNarrator matchea gender+edad de voiceLibrary, evita mismatch género
4. **TTS robusto:** ElevenLabs primario + OpenAI fallback, con cache para no regenerar
5. **Español neutro:** toNeutralSpanish normaliza voseo ANTES de TTS (regla dura del owner)
6. **Word sync:** `/with-timestamps` genera timings por palabra, detecta enumeraciones, planifica micro-escenas sincronizadas
7. **Multi-voz:** arquitectura lista, emitida futura (no hoy)

**⚠️ Gotchas (03-guion-voz-tts):**
- voice-selector.ts DEBE correr ANTES de ttsCacheKeyFromScript() — si NO, la cache key usa voiceId incorrecto (defaultVoice femenina) para un narrador macho, reciclando audio incorrecto. Orden: selectVoiceForNarrator → actualizar brand.defaultVoice → cache key → síntesis (apps/web/lib/pipeline.ts:239–268)
- narrator-analyzer DEBE corer ANTES de TTS para que narratorProfile esté poblado cuando selectVoiceForNarrator lo consulte. Si no corre, voice selector cae a defaultVoice siempre (apps/web/lib/pipeline.ts:187–213)
- toNeutralSpanish() se aplica a nivel SEGMENTO (parsedScript.segments[].text), ANTES de TTS. Audio, subtítulos y escenas heredan el texto normalizado. Si no normalizas aquí, saldrán con voseo (bloqueante por CLAUDE.md invariante)
- VOSEO_MAP es un lookup CONSERVADOR a propósito — imperativos homógrafos sin tilde ('salí', 'sentí', 'descubrí') NO se tocan para no romper pretérito válido. La compuerta con detectVoseo() atajaría queches, pero no es automático
- OpenAI TTS no soporta SSML <break> — concatenamos segmentos con \n\n (doble newline) para pausas. Estimación de duración es aproximada (text.length / 15), diferente de ElevenLabs real. Úsalo solo como fallback
- fetchWordTimings() DEBE usar MISMO prompt + voiceId + voiceSettings que la síntesis previa. Si cambia el texto, voz o settings, los timestamps serán para otra síntesis (errores de alineación)
- word-sync: detectEnumerations requiere PARALELISMO (todos con artículo O todos sin artículo, nunca mixto) para evitar falsos positivos. Máximo 3 palabras por ítem tras recortar lead-in (apps/web/lib/pipeline.ts línea 114). Detecta comas y conectores pero no es regex puro
- AudioTrack.durationSeconds debe ser REAL del mp3 (getVideoDurationSec con ffmpeg bundled de Remotion), no estimada. Estimación fallida causaba scenes de 6-11s imposibles (#142 2026-05-29). Fallback: (~15 chars/s ES) solo si ffmpeg falla
- subtítulos: NO se emiten salvo que user pida o preset lo active. subtitlesGoogle bloque existe pero NO corre en pipeline normal. ZapCap solo si subtitlesZapcap override o preset.subtitles.autoZapcap.enabled (apps/web/lib/pipeline.ts:600–620)
- multi-voz (speakerId): campo YA existe en scene.schema.ts pero pipeline NO lo emite. narrator-analyzer solo detecta 1 narrador. Para multi-voz hay que extender narrator-analyzer + router de voces por speaker + segmentar audio (no hoy)
- brand.defaultVoice.gender DEBE estar en ElevenLabsVoiceConfig para que voice selector funcione. Si falta o es null, selectVoiceForNarrator cae a defaultVoice sin warnings claros. Revisar vitaly.brand.json y biozentra.brand.json para consistency
- cache key de TTS incluye voiceId + modelId + speedMultiplier + provider — una change a cualquiera invalida la key. Si cambias voz sin cambiar key, cachés antiguas persisten (incoherencia). El pipeline lo maneja bien hoy (apps/web/lib/tts-cache.ts)
- GeminiClient fallback a Vertex AI cuando AI Studio devuelve 'prepayment depleted' (si GCP_PROJECT_ID seteado). No es visible en narrator-analyzer pero está en @video-factory/block-scene-planner GeminiClient. Revisar si GOOGLE_AI_API_KEY vs. GCP keys son coherentes


---

# Subsistema 04-Imagen: Generación, Validación y Refinamiento de Imágenes Escena-a-Escena

## Propósito

El subsistema 04-imagen es el **motor central de generación y validación de imágenes verticales 9:16** en Video Factory. Orquesta tres capacidades críticas:

1. **Generación multi-proveedor** con fallback automático (OpenAI → Gemini → Vertex → Higgsfield → fal.ai)
2. **Validación tripartita** (cuestionario estructurado + panel de especialistas + adversarial) con SceneValidatorV3
3. **Anclaje de identidad y referencia de estilo** para coherencia cross-escena (character anchor, referenceImage image-to-image)

## Arquitectura End-to-End

### Capa 1: Provider Chain (Cascada de Proveedores)

**Ubicación:** `apps/web/lib/image-gen-tools.ts:buildImageProviderChain()`, `packages/blocks/image-gen-multi/src/block.ts:providerSteps`

**Flujo:**
```
Scene prompt → ProviderStep 1 (OpenAI gpt-image-1)
              ↓ (si falla: daily quota, NSFW, timeout)
              → ProviderStep 2 (Gemini Nano Banana, gemini-2.5-flash-image)
              ↓ (fallback)
              → ProviderStep 3-5 (Vertex Imagen: fast → std → ultra)
              ↓ (fallback)
              → ProviderStep 6-8 (AI Studio Imagen: fast → std → ultra)
              ↓ (fallback)
              → ProviderStep 9 (Higgsfield Flux Pro Kontext)
              ↓ (fallback)
              → ProviderStep 10-11 (fal.ai Flux Pro/Dev)
```

**Orden en pipeline.ts (línea 917-989):**
- OpenAI como primario (sin daily caps, billing Tier 2+)
- Gemini Nano Banana intercalado (pool independiente, política contenido permisiva)
- Vertex Imagen (project quota, herencia del historial de Imagen 4)
- AI Studio Imagen (daily caps 170/día, fallback cuando vuelve)
- Higgsfield + fal.ai (para estilos photo-realistic/UGC)

**Throttling por Proveedor (Bottleneck):** `packages/blocks/image-gen-multi/src/block.ts:getLimiter()`
- Cada proveedor tiene su propio `Bottleneck` limiter con rate limits realistas:
  - `gemini-image`: 30 IPM (Tier 1 paid), maxConcurrent 8
  - `vertex-imagen`: 100 RPM, minTime 600ms, maxConcurrent 4
  - `openai-image`: Tier 2+, maxConcurrent 10, minTime 100ms
  - `google-imagen`: (AI Studio) 1 concurrent, minTime 6000ms (daily caps)
  - `higgsfield-image`: maxConcurrent 8
  - `fal-image`: maxConcurrent 12

Los limiters son **por-módulo** (compartidos entre concurrentes workers) para que dos rips paralelos respeten el mismo throttle global.

**Resiliencia a 2 niveles:**
1. **Retry con backoff** (línea 505-615): 429/5xx transitorios → espera exponencial (4·2ⁱ segundos)
2. **Provider fallback**: Si isDailyQuotaExhausted → marcar step como exhaustedSteps, saltar al siguiente

**Detección de errores recuperables:**
```typescript
// ImageProviderError flags:
- isDailyQuotaExhausted ✓ → fallback automático
- isContentRejection (NSFW) ✓ → fallback O sanitizar prompt
- retryable ✓ → retry con backoff
- timeout/ETIMEDOUT/ECONNRESET/5xx ✓ → retry (regex check línea 149-151)
```

**No recuperables (propagan):** Auth errors, malformed requests, todos los demás.

### Capa 2: Anclaje de Identidad (`characterAnchorImage`)

**Ubicación:** `apps/web/lib/pipeline.ts:1121-1152`, `packages/blocks/image-gen-multi/src/block.ts:generateWithIdentityAnchor()`

**Propósito:** Asegurar que el **personaje recurrente sea la misma persona** en todas las escenas que lo incluyen.

**Flujo:**
```
1. Si overrides.identityAnchor O preset.visualStyle.consistentCharacter:
   - narratorProfile.characterCard → describe al Dr. Sato, mujer 35 años, etc.
   - generateCharacterAnchor() genera UNA imagen de referencia de este personaje
   - Imagen se persiste en workDir/character-anchor.png

2. Para cada escena CON scene.featuresCharacter = true EN primer attempt:
   - Enviar currentPrompt + characterAnchorImage → generateWithIdentityAnchor()
   - Usar Gemini Nano Banana image-to-image con prompt reforzado:
     "the recurring person must be the SAME INDIVIDUAL as in the reference — 
      same face, age, hair, skin tone and build. You MAY change pose, framing, action."
   
3. Si Nano Banana falla (sin GOOGLE_AI_API_KEY u error):
   - Fallback a chain normal (callImagenWithApiRetry)
   - No rompe el pipeline
```

**Critical rule** (línea 258-280): `doesSceneShowNarrator()` detecta si el imagePrompt describe al narrador:
- Extrae keywords del characterCard (profesión, etnia, género, rasgos distintivos)
- Si prompt menciona esos keywords → probablemente muestra al narrador
- Heurística adicional: si prompt menciona "patient", "young woman", "other person" → NO es el narrador

Esto es **crítico porque el validator recibe `narratorProfile` solo cuando la escena realmente lo muestra**, evitando falsos positivos tipo "character mismatch" cuando la escena describe a la paciente.

### Capa 3: Referencia de Estilo (High Fidelity, image-to-image)

**Ubicación:** `apps/web/lib/pipeline.ts:1075-1100`, `packages/blocks/image-gen-multi/src/block.ts:providerSteps prepend`

**Propósito:** Cuando se ripea un ad y se trae una **imagen de referencia del original**, anclar el ESTILO generado a esa referencia sin copiar su contenido.

**Flujo:**
```
1. Si preset.visualStyle.referenceImages[0] es data-URI:
   - Decodificar de base64 → Buffer (presetReferenceImage)
   - Pasar a ImageGenMultiBlock

2. ImageGenMultiBlock prepend un step Nano Banana CON referenceImage:
   providerSteps = [
     {
       provider: GeminiImageProvider,
       model: 'gemini-2.5-flash-image',
       label: 'gemini:nano-banana-ref',
       referenceImage: Buffer (decoded)
     },
     ...restOfChain (fallback)
   ]

3. Cuando se llama a provider.generate():
   - Reforzar prompt: "use provided reference ONLY to match visual STYLE — 
     color palette, lighting, art medium, character-rendering style. 
     Render THIS scene's content in that same style. 
     Do NOT copy reference's objects, composition, text/UI/logos."

4. Si referenceImage = undefined (preset sin referencia):
   - providerSteps queda = baseProviderSteps (cero impacto, backward compat)
```

Implementa el **modo "Ripeo de Alta Fidelidad"** (sin iteración visual) vs **modo "Rápido"** (default con validator V3).

### Capa 4: SceneValidatorV3 — Validación Tripartita

**Ubicación:** `packages/blocks/scene-validator/src/validator-v3.ts`

**Estructura:** 3 pasadas paralelas (wall-clock ~5-6 segundos):

#### Pasada 1: Cuestionario Estructurado + Análisis Determinístico
```
Sistema: FORENSIC evaluator (línea 128-234)
Pregunta fielmente: 
  - Cuántos dedos en cada mano (enumeración obligatoria, no estimación)
  - Cuántos toes en cada pie
  - Face: simetría, features completas
  - Text: legible y significativo (no gibberish)
  - Numbers: secuenciales (si calendar)
  - Physics: gravedad, sombras consistentes, perspectiva
  - Character match vs narratorProfile
  - Semantic: image matches narration
  - Element logical coherence: "pressure marks" = indentaciones naturales, NO símbolos abstractos
  - Body part fusion: dos partes del cuerpo que se funden imposiblemente

Respuesta: JSON estructurado (V3StructuredAnswers, línea 45-105)

Análisis: analyzeStructuredAnswers() (línea 910-1150)
  - score = 100 - penalizaciones por issue
  - critical = true si anatomía humana / face / semantic grave
  - severity = 'critical' / 'minor' / 'none'
  - refinementHint = instrucción concreta para regenerar
```

#### Pasada 2: Panel de Especialistas Paralelos (solo si humans_visible + anatomía visible)

**En anatomyMode='strict' (default):** 2 llamadas Gemini independientes voting
- `anatomyVotingPass()` (línea 540-667): chequea hands, feet, eyes, ears, teeth, hair, limbs, neck, body proportions
- **Consensus rule:** Solo marcar falla si AMBOS evaluadores dicen perfect=false (evita falsos positivos)
- Si ambos rechazan → agrega issue "[anatomy-panel]" + penaliza score -20

**En anatomyMode='lenient' (cartoon/ilustrado):** Skip anatomía humana (dedos/toes/proporciones son estilo)

**Nuevos especialistas (línea 398-432):**
- `narrativeFitPass()` (línea 675-743): subject match, focal point, scale, composition, mood, contradictions
- `realWorldCoherencePass()` (línea 749-815): physics, scale coherence, era consistency, placement logic, spatial logic
- `aiArtifactPass()` (línea 822-881): melted forms, fused objects, duplicate background, impossible symmetry, abstract blobs, gibberish text, edge failures

Cada especialista devuelve `SpecialistVerdict`:
```typescript
name: 'narrative-fit' | 'real-world' | 'ai-artifact'
score: 0-100
verdict: 'approve' | 'reject'
issues: string[]
refinementHint: string | null
```

**Aggregación:** Cualquier especialista con verdict='reject' → detResult.severity='critical' + score ajustado

#### Pasada 3: Adversarial Critique (SOLO si score 70-79 Y no fastMode)

Sistema: AI-GENERATION ARTIFACT DETECTOR (línea 236-292)
- Hiper-crítico: busca defectos que traicionan al "AI-gen"
- CRÍTICO → rechaza (extra digits, fused, imposible anatomy, gibberish, etc.)
- MENOR → nota pero aprueba (wardrobe, eyewear, minor asymmetry, etc.)

Devuelve AdversarialResult con criticalIssuesFound[] y verdict

**Agregación final** (línea 507-537):
```
allIssues = structured + anatomy + specialist + adversarial
aggregatedScore = min(structured, adversarial) + specialist voting
allApprove = (structured ok) AND (adversarial ok) AND 
             (all specialists ok) AND (score ≥ 75)
verdict = allApprove ? 'pass' : 'regenerate'
```

**En fastMode (línea 1173):**
- Skip anatomy voting (2 calls Gemini) → ahorro ~7s
- Skip adversarial (1 call Gemini) → ahorro ~5s
- Skip sequence validator → ahorro ~30s
- maxValidationRetries baja a 1 → ahorro ~10 min peor caso
- Trade-off: ~10-15% más probabilidad de pasar errores anatómicos sutiles

### Capa 5: Claude Judge (M2, Segundo Par de Ojos)

**Ubicación:** `packages/blocks/preview-judge/src/judge.ts`, `packages/blocks/image-gen-multi/src/block.ts:useClaudeJudge`

**Activación:** Solo si V3 pasó (verdict='pass') Y ANTHROPIC_API_KEY configurada Y useClaudeJudge=true

**Invocación** (línea 775-894):
```typescript
judgeImage({
  imageBuffer,
  prompt: currentPrompt,
  sceneNarration: scene.text,
  brandContext: { brandId, palette, styleSummary, productName },
  expectedStyle: styleBase,
  scenePosition: { index, total, shotType },
  prevScenesContext: [escenas N-2, N-1], // coherencia temporal
  scriptFullSummary: resumén guion
})
```

**Respuesta:** JudgeReport con:
```typescript
pass: boolean
scoreVisual: 0-100
scoreBrandFit: 0-100
scoreHookStrength: 0-100
scoreLogicalCoherence: 0-100
scoreViveness: 0-100
issues: {
  severity: 'minor' | 'major' | 'critical'
  category: string
  description: string
  suggestedSystemicPatch?: string // wired a prompt-patches
}[]
suggestions: string[]
rationale: string
```

**Lógica:**
- Si claudeReport.pass=false → override v3PassesGate=false
- Issues se convierten a refinementHint para próximo attempt
- Si `suggestedSystemicPatch` encontrado: callback `onSystemicPatchSuggested()` → pipeline trackea cross-scene y registra en prompt-patches para review

**Costo:** ~$0.001-0.003 por imagen (Haiku 4.5), ~2-4s latencia

### Capa 6: Sequence Validator (Coherencia Cross-Escena)

**Ubicación:** `packages/blocks/scene-validator/src/sequence-validator.ts`, `packages/blocks/image-gen-multi/src/block.ts:validateSequence`

**Activación:** if (validateSequence && !fastMode) → post-batch review de TODAS las imágenes juntas

**Flujo** (línea 989-1086):
```
1. Cargar todas las imágenes generadas (scenes[].imagePath)
2. Construir prompt multimodal con las 27+ imágenes + narration + narrator profile
3. Gemini Vision 2.5-pro critica la SECUENCIA COMPLETA:
   - Continuidad de personajes (mujer escena 0 != mujer escena 25)
   - Continuidad de paleta y estilo
   - Flujo narrativo lógico
   - Proporciones relativas
   - Escala y ambientación
   - Transiciones visuales

4. Devuelve SequenceValidationResult:
   overallScore: 0-100
   scenesToRegenerate: [
     { sceneIndex: 5, issue: "character_continuity_break", 
       refinementHint: "Concrete instruction" }
   ]

5. Para cada escena flagged (if overall < minSequenceScore):
   - Regenerar UNA vez más con refinementHint concatenado al prompt
   - NO consume validation retries (es post-hoc)
```

**Score mínimo:** minSequenceScore (default 75)

## Funciones Clave con Archivo:Línea

| Función | Archivo | Línea | Propósito |
|---------|---------|-------|----------|
| `buildImageProviderChain()` | `apps/web/lib/image-gen-tools.ts` | 35-110 | Construye cadena ordenada de providers |
| `generateImageWithChain()` | `apps/web/lib/image-gen-tools.ts` | 123-160 | Genera imagen con fallback automático |
| `generateImageWithReference()` | `apps/web/lib/image-gen-tools.ts` | 175-204 | Genera anclada a referencia (Nano Banana) |
| `compareImagesWithVision()` | `apps/web/lib/image-gen-tools.ts` | 295-363 | Compara original vs generada (Gemini Vision) |
| `pickReferenceFrameIndex()` | `apps/web/lib/image-gen-tools.ts` | 395-431 | Elige frame representativo de keyframes |
| `buildIdentityPrompt()` | `packages/blocks/image-gen-multi/src/block.ts` | 83-92 | Envuelve prompt con instrucción de identidad |
| `generateWithIdentityAnchor()` | `packages/blocks/image-gen-multi/src/block.ts` | 96-105 | Genera escena anclada a character anchor |
| `buildEditPrompt()` | `packages/blocks/image-gen-multi/src/block.ts` | 46-55 | Construye prompt de EDIT (overlay/mixeo) |
| `applyEditStep()` | `packages/blocks/image-gen-multi/src/block.ts` | 60-78 | Aplica efecto sobre imagen base |
| `preferredProviderOrder()` | `packages/blocks/image-gen-multi/src/block.ts` | 110-122 | Reordena providers por componentType |
| `ImageGenMultiBlock.run()` | `packages/blocks/image-gen-multi/src/block.ts` | 378-1101 | Ejecuta la cascada completa (imagen + validation + regen) |
| `generateAndValidate()` | `packages/blocks/image-gen-multi/src/block.ts` | 638-976 | Loop escena: genera + valida + refina |
| `callProviderWithApiRetry()` | `packages/blocks/image-gen-multi/src/block.ts` | 479-621 | Retry + fallback a siguiente provider |
| `SceneValidatorV3.validate()` | `packages/blocks/scene-validator/src/validator-v3.ts` | 308-538 | Ejecuta panel tripartita + adversarial |
| `analyzeStructuredAnswers()` | `packages/blocks/scene-validator/src/validator-v3.ts` | 910-1150 | Análisis determinístico del cuestionario |
| `anatomyVotingPass()` | `packages/blocks/scene-validator/src/validator-v3.ts` | 540-667 | 2 evaluadores anatomy voting |
| `narrativeFitPass()` | `packages/blocks/scene-validator/src/validator-v3.ts` | 675-743 | Especialista: story-telling |
| `realWorldCoherencePass()` | `packages/blocks/scene-validator/src/validator-v3.ts` | 749-815 | Especialista: física, escala, era |
| `aiArtifactPass()` | `packages/blocks/scene-validator/src/validator-v3.ts` | 822-881 | Especialista: defectos AI-gen |
| `SceneSequenceValidator.review()` | `packages/blocks/scene-validator/src/sequence-validator.ts` | 118-201 | Multimodal post-batch de toda secuencia |
| `doesSceneShowNarrator()` | `packages/blocks/image-gen-multi/src/block.ts` | 255-280 | Detecta si escena muestra al narrador |
| `recordSceneError()` | `packages/blocks/image-gen-multi/src/block.ts` | 1143-1172 | Registra error en Error Memory |

## Flujo Integrado en Pipeline

**Ubicación:** `apps/web/lib/pipeline.ts:904-1275`

```
1. A.1-A.4 — Scene-planner, script-processor, narrator-analyzer, tts-generation
   ↓
2. B.0 — Character Anchor (si wantIdentity=true)
   - generateCharacterAnchor() → workDir/character-anchor.png
   ↓
3. B.5a — SI overrides.referenceVideoPath (modo Ripeo Fiel):
   - alignScenesToReferenceVideo() con rip-fidelity-aligner
   - Genera + compara contra keyframes originales hasta ≥95%
   - Salta ImageGenMultiBlock
   ↓ ELSE (default)
   ↓
3. B.5b — ImageGenMultiBlock (modo Rápido):
   - new ImageGenMultiBlock({
       concurrency: 8,
       providerChain: [openai, gemini, vertex, aistudio, higgsfield, fal],
       referenceImage: presetReferenceImage (si preset.visualStyle.referenceImages),
       characterAnchorImage,
       anatomyMode: routeProfile.validator.anatomyMode,
       validate: true,
       maxValidationRetries: 3,
       minPassScore: 85,
       validateSequence: true,
       minSequenceScore: 80,
       fastMode: true,
       useClaudeJudge: true,
       brandContext: { brandId, styleSummary, language, productName },
       scriptFullSummary: parsed.segments.map(s => s.narration).join(' ')
     })
   - generateAndValidate() para cada escena:
     - attempt 0: Si featuresCharacter, try characterAnchor; else normal chain
     - attempt 1-3: Retry con refinementHint concentado
     - Content rejection: sanitizar prompt auto
     - Max retries: 3 (fastMode=1), minPassScore=85
   - Sequence validation post-batch
   ↓
4. B.6-D — Scene-animator, compositor, post-render-judge, editor-ia-verdict
```

**Estado de run:**
- currentStep: 'image-gen-multi'
- progress: 55 (inicio) → 78 (fin)

## Entradas y Salidas

### Input (SceneTrack)

```typescript
interface SceneTrack {
  scenes: Scene[]
}

interface Scene {
  index: number // 0-indexed dentro del run
  text: string // narración
  imagePrompt: string // descripción visual generada por scene-planner
  compositeLayout?: string // 'single' | 'composite-layout-id'
  componentType?: string // 'cgi-macro' | 'overlay-on-body' | 'real-ugc-human' | etc.
  featuresCharacter?: boolean // true si el personaje recurrente aparece aquí
  editStep?: { effectPrompt: string; region?: string } // overlay/mixeo post-gen
}
```

### Output (SceneTrack actualizado)

```typescript
interface Scene {
  // ... (todo lo anterior)
  imagePath: string // workDir/scene_XX.png (image buffer persistido)
}
```

**Archivos generados en workDir:**
```
scene_00.png, scene_01.png, ..., scene_26.png (imágenes finales)
character-anchor.png (si identityAnchor=true)
```

**Logs:**
- `image-gen-multi:scene_validated` (verdicto per-scene)
- `image-gen-multi:scene_done` (escena aceptada)
- `image-gen-multi:scene_done_with_issues` (escena con warnings)
- `image-gen-multi:provider_daily_quota_exhausted_switching`
- `image-gen-multi:sequence_review_start / reviewed / regenerated`
- `image-gen-multi:claude_judge_verdict` (si useClaudeJudge)

## Configuración de Validación (Tuning)

Parámetros en `pipeline.ts:1154-1202`:

| Parámetro | Valor | Propósito |
|-----------|-------|----------|
| `concurrency` | 8 | Workers paralelos generando escenas |
| `maxValidationRetries` | 3 (1 en fastMode) | Intentos de regeneración por validación |
| `minPassScore` | 85 | Score mínimo para aceptar escena |
| `validateSequence` | true | Validador multimodal post-batch |
| `minSequenceScore` | 80 | Score mínimo secuencia |
| `fastMode` | true | Skip anatomy voting + adversarial |
| `useClaudeJudge` | true | Segundo par de ojos con Claude Haiku |
| `anatomyMode` | 'strict' (default) o 'lenient' (cartoon) | Reglas de validación anatomía |

## Cost Tracking

**Ubicación:** `apps/web/lib/pipeline.ts:linea post-image-gen`

Cada proveedor genera su propio evento de cost:
- OpenAI gpt-image-1: ~$0.04/imagen (medium quality)
- Gemini Nano Banana: ~$0.03/imagen
- Vertex/AI Studio Imagen: ~$0.02/imagen
- Higgsfield Flux Pro: ~$0.05/imagen
- fal.ai Flux Pro: ~$0.05/imagen

**Budget:** $5-7 por video (27 escenas típicamente)

## Gotchas y Casos Límite

1. **Provider exhausted vs retryable:** Si un provider tira 429 TRANSIENT por más de MAX_API_RETRIES (5), el bloque lo marca como `exhaustedSteps` y salta al siguiente. NO lo tira inmediatamente. (Bug 2 fix, investigacion/01-image-gen-multi-block-analysis.md)

2. **Character anchor fallback:** Si generateWithIdentityAnchor() falla (sin GOOGLE key), fallback silencioso al chain normal. Nunca rompe la escena.

3. **Content rejection (NSFW):** Primer intento = refusal con prompt original. Segundo intento = sanitizar prompt ("avoid NSFW"). Tercer intento = safe placeholder abstract. Si todo falla, scene_done_with_issues + Error Memory.

4. **narratorProfile mala detección:** Si imagePrompt menciona "patient" pero narratorProfile describe "doctor" → validator recibe narratorProfile=undefined → evita falso positivo de "character mismatch". Critical: `doesSceneShowNarrator()` maneja esto.

5. **Sequence validator timeout:** Si multimodal >27 imágenes tira timeout, cae silenciosamente (no bloquea). Siguiente run el sequence validator se reintenta.

6. **Claude Judge error:** Si ANTHROPIC_API_KEY down o error de API, se loguea warning y continúa con V3 verdict. Nunca rompe pipeline.

7. **fastMode trade-off:** Ahorra ~10-15 minutos (skip anatomy voting + adversarial + sequence) pero ~10-15% más probabilidad de pasar errores sutiles. Recomendado solo para iteraciones rápidas internas, NO para runs finales.

8. **Min pass score threshold:** minPassScore=85 es SUPERIOR al threshold de verdict='pass' del validator V3. Un imagen puede tener verdict='pass' pero score=72 < 85 → aún regenera. Esto fuerza más iteraciones pero calidad superior.

9. **Validación tripartita paralela:** Las 5 llamadas Gemini corren en Promise.all(), así que wall-clock ~5-6 segundos por escena (no 25 segundos secuencial). Critical para latencia total.

## Estado Actual y Capacidades Verificadas

✅ **Funcional y Tested (Producción Jun 2026):**
- Multi-proveedor cascada con fallback per-scene
- Throttling inteligente per-provider vía Bottleneck
- Cuestionario estructurado V3 + análisis determinístico
- Panel de 5 especialistas (anatomía, narrative-fit, real-world, ai-artifact)
- Consensus voting anatomía (evita falsos positivos)
- Validación tripartita en paralelo ~5-6 segundos
- Adversarial critique (solo si score 70-79)
- Character anchor identity (misma persona)
- Reference image high-fidelity (image-to-image Nano Banana)
- Edit step overlay post-gen (best-effort)
- Sequence validator post-batch
- Claude Judge M2 segundo par de ojos
- Fast mode (skip some validations, ~10-15 min ahorro)
- Content rejection sanitization + safe placeholder fallback
- Error Memory recording per-scene

⚠️ **Experimental / WIP:**
- `onSystemicPatchSuggested` callback (Claude Judge → Prompt Evolution)
- Route profiles (anatomyMode lenient para cartoon)
- `prevScenesContext` en Claude Judge (coherencia temporal)

## Referencias Cruzadas

- **Rip-fidelity-aligner:** `apps/web/lib/rip-fidelity-aligner.ts` (modo "Ripeo Fiel" con iteración visual)
- **Character anchor:** `apps/web/lib/character-anchor.ts` (generación anchor identity)
- **Route profiles:** `apps/web/lib/route-profiles.ts` (resolución perfil: anatomyMode, fastMode triggers)
- **Image-gen-imagen providers:** `packages/blocks/image-gen-imagen/src/*` (OpenAI, Vertex, GeminiImage, etc.)
- **Preview judge (M2):** `packages/blocks/preview-judge/src/judge.ts` (Claude Haiku)
- **Prompt evolution:** `apps/web/lib/prompt-evolution.ts` (onSystemicPatchSuggested callback)

**⚠️ Gotchas (04-imagen):**
- Provider exhausted ≠ error fatal: Si un step agota retries transitorios (429 x5), se marca exhaustedSteps y fallback al siguiente. Sin esto, un provider colgado mata todo el rip sin tocar fal/Higgsfield.
- Character anchor fallback silencioso: Si generateWithIdentityAnchor() sin GOOGLE key, cae al chain normal. Nunca propaga error.
- narratorProfile false detection: Si scene muestra 'paciente' pero narratorProfile describe 'doctor', pasar narratorProfile confunde al validator (falso positivo 'character mismatch'). Critical: doesSceneShowNarrator() lo maneja bien.
- Sequence validator post-batch: Si tira timeout con 27+ imágenes, cae silenciosamente (no bloquea). No es fatal.
- Claude Judge no es bloqueante: Si ANTHROPIC_API_KEY down, se loguea warning y continúa. Nunca rompe pipeline.
- fastMode trade-off reales: ~10-15% más errores anatómicos sutiles por ahorrar ~10-15 min. Solo para iteraciones internas, no finales.
- minPassScore > verdict='pass' threshold: imagen con verdict='pass' score=72 < minPassScore=85 aún regenera. Esto es intencional, fuerza calidad.
- Validadores paralelos wall-clock: 5 calls Promise.all() ~5-6s, NO 25s secuencial. Critical para latencia.
- Content rejection sanitization: NSFW prompt → sanitizar auto + retry. Si still rejects → safe placeholder abstract. If that fails too → scene_done_with_issues (no fatal).
- Throttling per-módulo, no per-instancia: Limiters viven a nivel módulo para que dos rips paralelos compartan el mismo throttle global. Per-instancia rompería los caps.


---

# Subsistema 05-Animación (Scene-Animator + Providers)

## Propósito End-to-End

Transforma cada imagen estática de una escena generada (PNG) en un clip de video MP4 (8-10s) con movimiento real y coherencia de personaje. El proceso combina:

1. **Routing inteligente de providers**: Kling (B-ROLL animado), Higgsfield (UGC/realistas), Veo (fallback universal)
2. **Motion prompts dinámicos de 3 capas**: Derivados del tipo de escena (talking-head, product, anatomy, comic, etc.)
3. **Validación automática**: VALIDATOR CHAT IA verifica el clip y propone correcciones (motion/imagen)
4. **Feedback del owner**: Re-animación con provider distinto si el anterior falló la validación
5. **Modo colaborativo**: Pausa esperando aprobación del owner entre escenas (si está habilitado)

**Concurrencia**: Kling/Veo soportan 5 clips paralelos; con duración ~30-90s por clip, 30 escenas tarda 5-15 min. Costo: ~$3-12 por video.

---

## Arquitectura: Scene-Animator

**Archivo principal**: `apps/web/lib/scene-animator.ts` (1147 líneas)

### Entrada (AnimateScenesOptions)

```typescript
{
  sceneTrack: SceneTrack;              // Array de Scene con imagePath
  workDir: string;                     // Directorio de salida para MPs4
  veoApiKey: string;                   // Credencial Google AI Studio/Vertex
  klingAccessKey?: string;             // Credencial Kling (optional)
  klingSecretKey?: string;
  klingModel?: 'kling-v2-6' | ...;     // Default 'kling-v2-6'
  klingMode?: 'std' | 'pro';           // Default 'std'
  klingDuration?: '5' | '10';          // Default '5'
  higgsfieldKeyId?: string;            // Credencial Higgsfield (optional)
  higgsfieldKeySecret?: string;
  higgsfieldModel?: 'dop-turbo' | ...;
  preferHiggsfield?: boolean;          // Si true, Higgsfield PRIMARY
  concurrency?: number;                // Default 5 (Kling) | 4 (Veo)
  model?: VeoModel;                    // Default 'veo-3.1-lite-...'
  durationSeconds?: number;            // Default 8
  skipMissingImages?: boolean;
  preApprovedSceneIndices?: Set<number>; // Fork pre-aprobadas (saltan animación)
  skipVideoGen?: boolean;              // Estilo ilustrado → Ken Burns sin vídeo
  
  // VALIDATOR CHAT IA
  validator?: {
    enabled: boolean;
    runId: string;
    maxAttempts?: number;              // Default 2
    brandContext?: {...};              // Contexto de marca
    scriptFullSummary?: string;        // Resumen del guión (max 2000 chars)
    totalScenes?: number;
    onRegenerateImage?: (args) => Promise<{updatedScene, newStaticImagePath}>;
    onAntiPatternDetected?: (info) => void;
    model?: string;                    // Default 'claude-sonnet-4-5'
    apiKey?: string;
  };
  onSceneValidated?: (info) => void;   // Callback de progreso validación
  
  // MODO COLABORATIVO
  mode?: 'auto' | 'collaborative';    // Default 'auto' (no pausa)
  logger?: MinimalLogger;
  onProgress?: (done, total, currentSceneIndex) => void;
}
```

### Flujo Principal (animateScenes)

**Línea 490-1147**

1. **Inicializa clientes** (490-514):
   - VeoClient (siempre)
   - KlingClient (si credenciales)
   - HiggsfieldVideoClient (si credenciales)

2. **Configura concurrencia** (515-520):
   - Con Kling: concurrency=5 (es su límite de resource pack 1303)
   - Sin Kling: concurrency=4

3. **Worker pool** (593-1139):
   - Ejecuta `animateScene()` para cada scene en paralelo
   - Maneja pre-aprobadas (fork skip, línea 598-622)
   - Salta video si `skipVideoGen=true` (Ken Burns, línea 629-635)
   - Llama VALIDATOR CHAT IA si habilitado (661-878)
   - Manejo de intervenciones del owner (co-pilot, línea 663-746)
   - Pausa colaborativa esperando aprobación (948-1133)

### buildMotionPrompt (línea 143-249)

Genera prompt de "3 capas" que especifica **CÓMO animar**, NO qué contenido. Estructura:

- **Capa 1**: Acción física del sujeto (e.g., "la boca se abre/cierra hablando", "la región pulsa con brillo")
- **Capa 2**: Dinámico interno/secundario (e.g., "emoción interna leyendo en la cara", "luz cálida crece")
- **Capa 3**: Movimiento de cámara (e.g., "push-in lento 2-3%", "pan editorial")
- **Beat narrativo**: Intensidad según el tipo de escena (hook, problem, mechanism, demo, etc.)
- **Framing lock**: "MANTÉN EXACTO encuadre/crop/distancia — si es full-body, full-body; si close-up, close-up"
- **Reglas absolutas**: No nuevos personajes, no cambios de ropa, no recomposición

**Por tipo de escena** (línea 176-227):
- `talking-head/close-up`: Labios articula las palabras (LIP-SYNC si `speaking=true`), parpadeo, head tilt 3°
- `anatomy/anatomical`: Región pulsa suavemente, flujo directional, tracking
- `product`: Luz glint sobre superficie, rim-light, orbit sutil
- `split-screen/before-after`: Paneles independientes, contraste, cámara centrada
- `comic-panel`: Cada panel completa su gesto, pan horizontal
- `action`: Acción con follow-through, peso, gravedad en ropa/cabello
- `infographic/chart`: Elementos settle, punto pulsa, push a elemento clave
- **default**: Si habla → lip-sync; si no (voice-over) → boca neutral, sin lip-sync

**Versión actual** (v3.2 #144, 29-may-2026):
- NO inyecta `scene.imagePrompt` (evita que Kling re-imagine la escena)
- Motion prompt es PURO movimiento + framing lock
- La imagen es la única fuente de "qué se ve"

### animateScene (línea 259-483)

Routing en cascada con fallback:

```
Si forcedProvider especificado:
  └─ Intentar SOLO ese provider
     └─ Si falla → retorna Scene sin videoPath
Sino:
  Si preferHiggsfield Y higgsfield configurado:
    ├─ Intentar Higgsfield PRIMARY
    ├─ Si falla → sigue a Kling
    └─ Si Kling falla → sigue a Veo
  Sino:
    ├─ Intentar Kling PRIMARY (si existe)
    ├─ Si falla → sigue a Veo
    └─ Si Veo falla → retorna Scene sin videoPath
```

**Parámetros clave**:
- `motionPromptOverride`: Si VALIDATOR propone `correctedMotionPrompt`, lo usa en lugar de `buildMotionPrompt()`
- `forcedProvider`: Usado cuando VALIDATOR rechaza por "animation-broken" con provider X → intenta Y distinto (línea 279-382)

**Provider Priority** (línea 384-482):
- **Higgsfield (preferHiggsfield=true)**: Soul 2.0 = mejor realismo facial UGC (línea 386-417)
- **Kling**: v2-6 = mejor para B-ROLL animado Pixar/acuarela/comic (línea 420-451)
- **Veo**: Fallback (línea 454-482)

---

## Providers: Clientes

**Ubicación**: `packages/blocks/video-gen-veo/src/`

### 1. VeoClient (client.ts)

**Modelo**: Google Veo 3.1 (image-to-video)  
**Endpoints**:
- Primary: AI Studio `https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning`
- Fallback: Vertex AI (GCP) si AI Studio agota prepago (402/429 "prepayment depleted")

**Flujo**:
1. POST predict → operation name
2. Poll GET operation hasta done=true
3. Descarga video desde URI o base64

**Timeout**: 6 min (Veo Lite suele tardar 1-3 min)  
**Límite tokens**: 30k input/min (Sonnet 4-5)

**Manejo de errores**:
- `isPrepayDepletedError()` detecta "credits depleted" → reintenta Vertex AI
- `VeoApiError.retryable` marca si 429/5xx

**Credenciales**: `ANTHROPIC_API_KEY` (AI Studio) + `GCP_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS` (Vertex fallback)

### 2. KlingClient (kling-client.ts)

**Modelo**: Kling v2-6 (recomendado, 3-5 min/clip) o v2-master (legacy premium)  
**Base URL**: `https://api-singapore.klingai.com`  
**Autenticación**: JWT HS256 (header `Authorization: Bearer <token>`)  
- Payload: `{iss: accessKey, exp: now+1800, nbf: now-5}`
- Firmado con `secretKey`

**Flujo**:
1. POST `/v1/videos/image2video` → task_id
2. GET `/v1/videos/image2video/{task_id}` → task_status + videos[].url
3. Descarga MP4 desde CDN

**Manejo de 1303 (Parallel Task Limit)**:
- Si 429 con código 1303 → retry con backoff: 15s, 20s, 25s, ... 55s
- Default 8 retries (configurable `maxParallelRetries`)
- Concurrencia global del pool: 5 (gestiona Kling internamente)

**Timeout**: 10 min (Kling v2 puede tardar 3-5 min)

**Credenciales**: `KLING_ACCESS_KEY` + `KLING_SECRET_KEY`

### 3. HiggsfieldVideoClient (higgsfield-video-client.ts)

**Modelo**: DoP (Director of Photography) image-to-video  
- Variantes: `dop-turbo` (recomendado), `dop-lite`, `dop-preview`
- ⚠️ NO existe `dop-standard` (API responde 422)
- ⚠️ Soul es TEXT-to-image, NO image-to-video

**Base URL**: `https://platform.higgsfield.ai`  
**Autenticación**: Header `Authorization: Key {keyId}:{keySecret}`

**Flujo**:
1. POST `/files/generate-upload-url` → upload_url + public_url
2. PUT bytes a upload_url (sin auth — URL firmada autoriza)
3. POST `/v1/image2video/dop` body: `{params: {model, prompt, input_images, duration}}`
4. Poll GET `/requests/{request_id}/status` → completed|failed|nsfw
5. Descarga video desde response.video.url (o varios shapes posibles)

**Shapes de respuesta** (múltiples historias de API):
- `response.video.url`
- `response.videos[0].url`
- `response.jobs[0].results.raw.url` o `.min.url`

**Timeout**: 10 min (queue 5 min + render 60-180s)  
**Intervalo poll**: 2 sec

**Credenciales**: `HIGGSFIELD_KEY_ID` + `HIGGSFIELD_KEY_SECRET`

---

## VALIDATOR CHAT IA (Integración)

**Ubicación**: `apps/web/lib/validator-chat-ia.ts` (parte del subsistema de animación)  
**Invocación**: Scene-animator línea 783-804

### Flujo de Validación

1. **Extrae keyframes**: `extractKeyframes()` — 2 frames/sec durante 8s = 8 imágenes (v3 "exhaustiva")
2. **Conversación multi-turn con Sonnet 4-5**:
   - Input: imagen estática + keyframes + historial anterior (si retry)
   - Claude analiza frames exhaustivamente
   - Emite JSON estructurado: `{verdict: 'right'|'wrong', issues: [...], correctedImagePrompt, correctedMotionPrompt, ...}`
3. **Si verdict=wrong con confidence ≥65**:
   - Si `correctedImagePrompt` → regenera imagen + reanima (línea 706-731)
   - Si `correctedMotionPrompt` → reanima con motion distinto (línea 801-802, `onReanimate`)
   - Reintenta hasta `maxAttempts` (default 2)
4. **Si verdict=wrong tras todos los retries**:
   - Marca scene `validatorRejected=true` + motivo (línea 839-850)
   - Compositor usa imagen estática + warning en UI
5. **Persiste**:
   - `history.jsonl` — cada turn estructurado
   - `scene_NN.md` — conversación legible
   - `scene_NN_latest.json` — último veredicto

### Errores Detectados (Owner 27-may-2026)

- Personajes enfermos (cara anorexica, ojos hundidos)
- Textos basura (hex codes #5DC3D2, "DDCDBA TRINES KREATO 88888")
- Clips estáticos (pierden retención)
- "Gallery mode" / "Expression Sheet" (sin gesto)
- Morphing visible (anatomía deformándose)
- Pose congelada en bucle

### Parámetros

- `enabled`: true/false
- `maxAttempts`: default 2 (intenta corrección 2 veces)
- `brandContext`: {brandId, productName, styleSummary, language}
- `onRegenerateImage`: Callback si VALIDATOR pide correctedImagePrompt
- `onReanimate`: Callback si correctedMotionPrompt (línea 801-802)

---

## Owner Feedback + Co-Pilot

**Ubicación**: `apps/web/lib/owner-feedback.ts` + `collaborative-mode.ts`

### Intervenciones Live (Línea 663-746, 948-1133)

**FIX RECIENTE** (29-may-2026, linea 691-730, 966-1002):

Cuando el owner clickea "Rechazar" CON o SIN `newImagePrompt`:
- **Antes**: Si solo dejaba comentario (sin newImagePrompt) → No se regeneraba
- **Ahora**: Derivamos el prompt corregido del comentario mismo:
  ```typescript
  const correctedPrompt = 
    intervention.newImagePrompt ||
    `${animated.imagePrompt}\n\nCORRECCIÓN DEL OWNER (arregla exactamente esto, manteniendo el estilo 3D y el personaje consistente): ${intervention.comment ?? 'la escena no tiene sentido con la narración; rehazla acorde a lo que se dice'}`;
  ```
  Luego regenera con `onRegenerateImage()` usando el prompt derivado.

**Owner interventions**:
- `approve`: Saltea VALIDATOR, acepta scene tal cual
- `reject`: Regenera con newImagePrompt (o derivado del comentario) + reanima
- `skip`: Acepta sin re-evaluar
- `comment`: Acumula (NO libera pausa colaborativa)

### Modo Colaborativo (waitForApprovalIfCollaborative)

Si `mode='collaborative'`:
1. Pausa después de cada scene (concurrency=1 forzado)
2. Setea `awaitingApproval=true` en DB
3. Loop de polling cada 5s leyendo intervenciones pendientes
4. Timeout defensivo: 60 min → fuerza stop del run

**Línea 1011-1013**: Si timeout sin aprobación → error claro: "El run se detuvo para no entregar una escena sin tu visto bueno — usa 'Forkear' desde la última escena aprobada"

### Propagación de Correcciones (propagate-corrections)

**Línea 1016-1126**: Si owner aprueba O rechaza con feedback substantivo:
1. Lee `propagateCorrections()` — Claude analiza el feedback del owner
2. Evalúa escenas FUTURAS (aún no procesadas)
3. Si aplica la corrección, actualiza `imagePrompt` in-place
4. Persiste en `scene-plan.json` para que UI refleje cambios

---

## Guardias de Consistencia (v3.2 #133)

**Línea 880-938** (CONSISTENCY GUARD):

Si VALIDATOR regeneró imagen pero la re-animación falló (ej. API 413):
- PNG en disco es MÁS NUEVO que MP4 → mismatch
- Guard detecta por mtime: `imgStat.mtimeMs > vidStat.mtimeMs + 1000`
- Fuerza UNA re-animación con motion prompt genérico antes de pausar

---

## Wiring de Provider Usado

**v3.2 #107** (Línea 529-591):

- Cada scene rastrea `lastProviderUsed` (`kling` | `veo` | `higgsfield`)
- Si VALIDATOR rechaza por motion/animation-broken → `pickNextProvider(lastUsed)` devuelve distinto
- Cascade: Kling → Veo → Higgsfield → Kling (cíclico)
- Evita repetir mismo provider si ignoró motion prompt anterior

---

## Flujo de Saldo (Balance Management)

**Veo** (AI Studio → Vertex fallback):
- 429 con "credits depleted" → Vertex AI fallback (si `GCP_PROJECT_ID`)

**Kling**:
- 1303 "parallel task over limit" → Retry con backoff (no es saldo, es concurrencia)

**Higgsfield**:
- 402/403 con "credit|quota|insufficient" → `isOutOfCredits=true` en HiggsfieldVideoError

Ninguno detiene el pipeline — si todos fallan, scene sin videoPath → compositor usa estática.

---

## Logging & Observabilidad

**Logger duck-type** (línea 34-37):
```typescript
interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}
```

**Eventos logged**:
- `scene_animated_higgsfield / _kling / _veo` — éxito (proveedor, bytes, tiempo)
- `higgsfield_failed_trying_kling` — fallback
- `cascading_to_different_provider_for_motion_retry` — VALIDATOR rechazó
- `fork_pre_approved_scene_skipping_animation_and_validator` — fork skip
- `skip_video_gen_using_ken_burns_on_static` — estilo ilustrado
- `owner_force_approved_scene_skipping_validator` — co-pilot approve
- `owner_force_rejected_regenerating` — co-pilot reject + regen
- `consistency_re_animation_succeeded / _failed` — guard
- `validator_chat_ia_approved / _rejected_scene` — VALIDATOR veredicto
- `collaborative_resumed` — owner aprobó
- `propagation_applied / _failed` — propagación de correcciones

---

## Invariantes Críticos del Subsistema

1. **Motion prompt NUNCA incluye contenido (imagePrompt)** — Solo movimiento + framing lock. La imagen es la fuente de verdad (v3.2 #143).

2. **LIP-SYNC exige voz nativa del MISMO modelo** — Veo 3.1 con diálogo nativo en el prompt, NO TTS aparte. La boca coincide porque se generan JUNTOS (CLAUDDE.md, invariante).

3. **Si Provider X falla motion → intenta Provider Y** — Cascade real. Si animator ignora motion prompt con X, retry con MISMO X produce clip idéntico (v3.2 #107).

4. **Validation es OBLIGATORIA si habilitada** — No opt-in ni fire-and-forget. Scene sin veredicto positivo → `validatorRejected=true` (CLAUDDE.md).

5. **Owner feedback SIN newImagePrompt SIGUE regenerando** — Si solo comenta "arregla esto" → derivamos prompt del comentario (29-may fix).

6. **Fork pre-aprobadas SALTAN TODO** — Ninguna animación, validación ni pausa colaborativa (v3.2 #135).

7. **Ken Burns en estilo ilustrado** — Si `skipVideoGen=true` → NO providers, scene sin videoPath, compositor aplica Ken Burns (v3.2 #142).

---

## Entradas/Salidas

**Input**: `AnimateScenesOptions` + SceneTrack con `imagePath` para cada scene

**Output**: `SceneTrack` donde cada Scene tiene:
- `videoPath`: Ruta al MP4 (si éxito)
- `validatorRejected`: true si VALIDATOR rechazó tras retries
- `validatorReason`: Motivo del rechazo
- `ownerForceApproved`: true si owner aprobó manualmente

**Side effects**:
- Escribe MP4 a `workDir/scene_NN.mp4`
- Persiste validaciones a `storage/validator-chat-ia/{runId}/`
- Registra intervenciones a `storage/owner-feedback-memory/`
- Logs a logger

---

## Archivos Clave

| Archivo | Línea clave | Función |
|---------|------|----------|
| `apps/web/lib/scene-animator.ts` | 143-249 | `buildMotionPrompt()` — 3 capas |
| `apps/web/lib/scene-animator.ts` | 259-483 | `animateScene()` — routing cascade |
| `apps/web/lib/scene-animator.ts` | 490-1147 | `animateScenes()` — main worker |
| `packages/blocks/video-gen-veo/src/client.ts` | 117-528 | VeoClient — AI Studio + Vertex |
| `packages/blocks/video-gen-veo/src/kling-client.ts` | 175-349 | KlingClient — JWT + retry 1303 |
| `packages/blocks/video-gen-veo/src/higgsfield-video-client.ts` | 164-266 | HiggsfieldVideoClient — upload + DoP |
| `apps/web/lib/owner-feedback.ts` | 138-220 | recordIntervention() — store feedback |
| `apps/web/lib/collaborative-mode.ts` | 57-185 | waitForApprovalIfCollaborative() — polling |

**⚠️ Gotchas (05-animacion):**
- Motion prompt NUNCA inyecta scene.imagePrompt (v3.2 #143) — eso hacía que Kling re-imaginara la escena. Es PURO movimiento + framing lock. La imagen es la única fuente de contenido.
- LIP-SYNC exige voz NATIVA del MISMO modelo (Veo 3.1) — NUNCA superpongas TTS aparte (ej. ElevenLabs) sobre clip muteado. La boca no coincidirá y VALIDATOR lo caza (invariante CLAUDE.md).
- Si Provider X ignora motion prompt → retry con MISMO X produce clip idéntico. Fuerza Provider Y distinto (pickNextProvider cascade, v3.2 #107, línea 541-549).
- Owner reject SIN newImagePrompt REGENERA IGUAL (29-may fix, línea 691-730) — derivamos prompt del comentario. Si solo comenta 'arregla esto' → prompts el comentario al modelo.
- Código 1303 de Kling NO es saldo, es concurrencia — retry con backoff (15→20→...→55s) hasta 8 veces. El pool mantiene concurrency=5 como límite GLOBAL.
- Veo 429 'prepayment depleted' → fallback a Vertex AI si GCP_PROJECT_ID configurado. Mismo modelo (mapeo automático veo-3.1-lite → veo-3.0-fast).
- Fork pre-aprobadas (preApprovedSceneIndices) SALTAN TODO — sin animación, sin VALIDATOR, sin pausa colaborativa. Preservan exactamente el trabajo del run original.
- Estilo ilustrado (skipVideoGen=true) → NO providers llamados, scene sin videoPath, compositor aplica Ken Burns fiel a estática. VALIDATOR + pausa colaborativa SIGUEN corriendo.
- Timeout colaborativo (60 min) → aborta run con error claro ('se detuvo para no entregar sin tu visto bueno'). Owner usa 'Forkear' desde última escena aprobada.
- Consistency guard (v3.2 #133) detecta PNG más nuevo que MP4 (mtime diff > 1s) → fuerza re-animación con motion prompt genérico. Evita mismatch tras fallo de VALIDATOR.
- VALIDATOR rechaza con confidence < 65 → NO intenta auto-corrección (probable worsening), escala como 'needs-human-review'. Threshold en línea 64 del validator-chat-ia.
- Higgsfield DoP NO es Soul (Soul es text-to-image). DoP variantes: dop-turbo (recomendado), dop-lite, dop-preview. NO existe dop-standard (API 422).
- onReanimate callback (línea 801-802) recibe correctedMotionPrompt de VALIDATOR y lo inyecta como override en animateScene (línea 275-276). Cierra loop VALIDATOR → animator.
- Intervention pending read SIEMPRE filtra processed=false. markInterventionProcessed reescribe JSONL atómicamente (v3.3 rename fallback, línea 289-301).
- Propagate corrections muta imagePrompt in-place en scene-track.scenes — la próxima iteración del worker verá el prompt nuevo (línea 1084-1089).


---

# Scene-Planner: División de Guión en Escenas Densas

## Propósito
El `scene-planner` (bloque 06 del pipeline) divide un guión narrado en N escenas visuales, cada una con timestamp sincronizado a la narración real (word-level si está disponible vía Whisper). Genera prompts visuales editoriales por escena y clasifica cada escena por tipo de componente visual, permitiendo que el pipeline siguiente (image-gen) rutee cada escena al mejor proveedor de generación de imágenes.

**Ubicación:** `packages/blocks/scene-planner/src/block.ts`

---

## Entradas y Salidas

### Input: `ScenePlannerInput`
```typescript
interface ScenePlannerInput {
  parsedScript: ParsedScript;           // guión estructurado (segmentos de narración)
  subtitleTrack?: SubtitleTrack;        // timestamps word-level reales de Whisper
}
```

**Crítico:** Si `subtitleTrack` está disponible, su duración **reemplaza** la estimación del script (`estimatedDurationSeconds`). La estimación es proporcional al texto y se desvía varios segundos del audio real, dejando cola silenciosa (block.ts:107-114).

### Output: `SceneTrack`
```typescript
interface SceneTrack {
  scenes: Scene[];
  totalDurationSeconds: number;
  styleBase: string;
  narratorProfile?: NarratorProfile;
}
```

Cada `Scene` contiene:
- `index, text, startTimeSeconds, endTimeSeconds` — posición en el timeline
- `imagePrompt` — descripción visual (30-70 palabras) para generar la imagen
- `speaking?: boolean` — ¿el personaje DICE esta línea (lip-sync=true) o es voice-over (false, default)?
- `textOverlays?: TextOverlay[]` — texto vectorial a renderizar en Remotion (producto, día, métrica)
- `editStep?: {effectPrompt, region}` — efecto a superponer sobre cuerpo real (ej. "flujo linfático glowing")
- `componentType?: 'cgi-macro' | 'real-ugc-human' | 'overlay-on-body' | 'other'` — tipo de componente
- `featuresCharacter?: boolean` — ¿muestra al personaje recurrente?

---

## Parámetros Clave de Configuración

### `targetSceneCount`
**Línea:** block.ts:33, 118-119

Número de escenas a generar. Default automático:
```typescript
targetSceneCount = Math.max(8, Math.round((totalDurationSeconds / 60) * 25))
```

**25 escenas por minuto** = ritmo de cortes estilo referencia premium TikTok/Reels (~2.4s por escena en un ad de 73s). Sobrescribible vía opción al construir el bloque.

**Crítico:** Es una **propuesta** a Gemini. El campo `text` de cada escena **JAMÁS debe estar vacío** (block.ts:232, 525-530). Si Gemini llena escenas con texto vacío, se filtran. Si no hay suficiente narración, mejor menos escenas densas que relleno basura.

### `ownerPreferences` (v3.2 #139)
**Línea:** block.ts:35-41, 399-404

Texto en lenguaje natural de preferencias visuales acumuladas del owner (ej: "La protagonista debe ser mujer de ~50 años, nunca embarazada. Estilo acuarela cálida, no fotorealista."). Se inyectan **arriba de todo** en el prompt con prioridad MÁXIMA, ganando sobre defaults (block.ts:400-401).

---

## Algoritmo Central

### Paso 1: Análisis del Narrador
**Línea:** block.ts:126-147

Llama a `analyzeNarrator()` (block.ts:566-609) para inferir el perfil del narrador desde el guión:
- `gender`: male | female | neutral
- `ageRange`: "20-30", "40-55", etc.
- `characterCard`: descripción visual de 35-60 palabras para que el ilustrador dibuje al personaje siempre igual
- `narratorPresent`: ¿el guión identifica explícitamente al hablante?

Si está en `input.parsedScript.narratorProfile`, usa ese (skip análisis). Si falla el análisis, fallback a defaults neutros (block.ts:140-145).

El `characterCard` se inyecta literalmente en cada prompt de escena donde aparece el narrador (block.ts:361-366).

### Paso 2: Detección de Estilo y Tipo de Plano
**Línea:** block.ts:163-228

Analiza `styleBase` (preset.visualStyle.promptTemplate) con regex para clasificar:

1. **ILLUSTRATED** (acuarela, cartoon, hand-drawn, etc.)
   - Regex: `hand[- ]?illustrated|painted by hand|watercolor|comic[- ]?style|disney 2d|pixar` (block.ts:181-184)
   
2. **PHOTO-REALISTIC / UGC** (smartphone, selfie, handheld, stock footage, real woman/man, etc.)
   - Regex: `phone[- ]?shot|smartphone|selfie|photo[- ]?realistic|ugc|dslr|stock footage` (block.ts:185-188)
   
3. **MOTION GRAPHICS** (kinetic typography, infographic, 2d animation)
   - Regex: `motion graphics|kinetic typography|explainer animated|infographic style` (block.ts:190-193)

**Crítico:** La heurística tiene falsos positivos — "stock medical illustrations" = footage real con overlays, NO cartoons hand-drawn. Por eso el regex requiere prefijos específicos ("hand-", "digital", "painted-by-hand") en lugar de matchear "illustration" plano (block.ts:176-179).

El `shotTypeGuide` se construye **DIFERENTE por tipo de estilo**, con tipos de plano específicos (block.ts:202-228):
- Fotorealista: close-up character, talking head, wide environment, product shot, stock-style detail
- Motion graphics: kinetic typography, iconic shape, infographic frame, abstract motion
- Ilustrado: close-up character, anatomical illustration, action scene, symbolic object, product shot, comic panel

### Paso 3: Construcción del System Prompt
**Línea:** block.ts:230-359

El prompt a Gemini es exhaustivo:

1. **REGLA #0 (CRÍTICA):** Cada escena DEBE tener `text` con contenido real. No devolver escenas con text vacío (block.ts:232).

2. **REGLA #1:** Imagen DEBE mostrar **literalmente** lo que el narrador dice. NADA de metáforas vagas (block.ts:234).

3. **REGLA #2:** Continuidad del narrador — usar literalmente la `characterCard` cuando aparece el narrador en distintas escenas (block.ts:236).

4. **REGLA #3:** Estilo visual — copiar el `styleBase` del preset al inicio de CADA imagePrompt, sin sustituirlo (block.ts:238-240).

5. **REGLA ANTI-EMBARAZO (HINCHAZÓN):** Cuando la narración hable de hinchazón/retención de líquido, **jamás generar iconografía de embarazo** (block.ts:247-263).
   - ❌ PROHIBIDAS: perfil con vientre redondo, manos acunando vientre, mirarse en espejo de perfil
   - ✅ PERMITIDAS: frente (no perfil), una mano presionando con molestia, ropa apretada, cara hinchada, vientre distendido plano (NO bulto redondo)

6. **REGLA ANTI-COLLAGE (UN SOLO CUADRO):** Cada imagePrompt describe **UN SOLO instante en UN SOLO cuadro vertical 9:16**. JAMÁS collage, grilla, multi-panel, split-screen, "character sheet" (block.ts:276-281).

7. **TEXT OVERLAYS — ESTRATEGIA CRÍTICA:** Los generadores constantemente fallan con texto (gibberish, inglés cuando el ad es español). Solución: **imagen limpia, texto agregado después** vía `textOverlays` (block.ts:265-305).
   - ⚠️ OJO: repetir "NO text" muchas veces es contraproducente (la negación prima al generador a DIBUJAR texto). Una sola mención concisa funciona mejor: `"Clean artwork with no lettering or captions baked into the image — any wording is added later in post-production."` (block.ts:289)
   - **CASOS para textOverlays:**
     1. Producto por nombre → `kind:"product-label"`
     2. Villano/personaje etiquetado → `kind:"product-label"`
     3. Cuenta de días → `kind:"day-counter", text:"DÍA 10"`
     4. Métricas/porcentajes → `kind:"metric-callout"`
     5. Carteles/banners → `kind:"subtitle-banner"`
   - **NUNCA** la narración como texto quemado en la imagen (block.ts:300-303).

8. **REGLA "speaking" (HABLA vs VOICE-OVER):** Para cada escena, decidir si el personaje DICE esa línea en primera persona (lip-sync, boca se mueve) o es VOICE-OVER (block.ts:307-319).
   - `speaking: true` → SOLO cuando el personaje dice literalmente esa frase en primera persona (talking-head testimonial)
   - `speaking: false` → DEFAULT. Voice-over: el narrador habla en off, vemos escenas ilustrativas. La boca NO se mueve con el texto.
   - Regla práctica: si dudás, pon false (block.ts:318-319).

9. **REGLA #4 — DURACIÓN TOTAL Y COBERTURA DE AUDIO:** La suma de duraciones de TODAS las escenas (calculada desde el `text` narrado) DEBE coincidir **EXACTAMENTE** con la duración total del audio. NO dejar huecos al final (block.ts:345-359).
   - Verificación obligatoria: si la última escena termina ANTES del final del audio, **EXTENDER su texto** para cubrir el resto (block.ts:350-352).
   - Si sobra narración sin asignar, **crear escenas adicionales** hasta agotar TODO el transcript (block.ts:351-352).

10. **REGLA ANATÓMICA:** Cuando un prompt muestre manos, di **EXPLÍCITAMENTE** `"hand with five fingers, thumb visible, all digits separated and anatomically correct"`. Para pies: `"foot with five toes"`. Para rostros: `"symmetrical face, two eyes, no distortion"` (block.ts:414).

### Paso 4: Inyección de Contexto Extendido
**Línea:** block.ts:368-415

1. **Lecciones aprendidas (Error Memory):** `queryRelevantErrors()` busca patrones de fallos pasados relevantes para este guión (block.ts:376-379). Se inyectan como `AVOID THESE PATTERNS` para que Gemini mejore automáticamente (block.ts:371-392).

2. **Brand Ingredients:** `buildIngredientsBlock()` inyecta (block.ts:394):
   - Descripción del logo + política de placement
   - Productos de la marca con precisión visual
   - Assets de referencia disponibles
   - Paleta de colores oficial
   - mustInclude / mustAvoid (reglas de la marca)

3. **Owner Preferences (v3.2):** Si está, inyecta con **PRIORIDAD MÁXIMA** arriba del narratorBlock (block.ts:399-404).

### Paso 5: Retry Robusto con Gemini
**Línea:** block.ts:429-501

Gemini ocasionalmente devuelve `{scenes: []}` por:
- Content safety borderline
- MAX_TOKENS
- Blip transitorio

**Reintentos:** Hasta 3 intentos con backoff exponencial (block.ts:436-450):
```
delay = 1500 * 2^(attempt-1) + random(0-500)ms
```

En el **último intento**, simplifica el prompt removiendo `lessonsBlock` (la pieza más larga que más probable triggea filtros safety) (block.ts:448-451).

Si tras 3 intentos no hay escenas válidas, devuelve `BlockError` con code:
- `API_4xx` — auth/bad request (no retryable a nivel de bloque, pero el run puede reintentar con otro preset)
- `NO_SCENES` — 3 intentos sin escenas (retryable a nivel run)

### Paso 6: Filtrado y Distribución de Timestamps
**Línea:** block.ts:525-542

1. **Filtrado:** Elimina escenas con `text` vacío o solo espacios (Gemini a veces rellena) (block.ts:525).

2. **Distribución:** `distributeTimestamps()` (block.ts:613-652) asigna timestamps PROPORCIONALES al LENGTH del `text`:
   ```typescript
   ratio = escena.text.length / totalChars
   duration = totalDuration * ratio
   ```
   La última escena se ajusta al `totalDuration` exacto (no redondeado) (block.ts:622).

---

## Clasificación de Componentes Visuales

### `deriveComponentType()` — Ruteo Automático
**Línea:** block.ts:662-695

Función DETERMINISTA que analiza `shotType` + `imagePrompt` para clasificar la escena. **Sin llamada extra al modelo** — facilita que image-gen rutee al mejor provider (block.ts:110-122).

**Lógica de clasificación:**

1. **`overlay-on-body`** — Si el prompt contiene términos de overlay:
   - Regex: `overlay|glowing|glow over|lymphatic flow|highlighted (veins|vessels)|energy lines|x-ray|thermal` (block.ts:666-669)
   - **Consume:** Cap 3 (editStep) + Nano Banana (image-to-image) para superponer efecto sobre cuerpo real

2. **`cgi-macro`** — Anatomía de corte transversal, macrofotografía, microscopia:
   - Regex: `macro|cgi|cross[- ]section|microscop|cellular|\bcell\b|tissue|anatom|diagram|bloodstream|vessel|molecul|\borgan\b` (block.ts:674-676)
   - **Consume:** Nano Banana (mejor para CGI) o Gemini Imagen

3. **`real-ugc-human`** — Persona REAL (no animada):
   - Detecta: `speaking=true` O regex human: `talking head|selfie|\bugc\b|testimonial|portrait|to camera|vlog|woman|man|person|people|face|girl|guy|mujer|hombre|persona|gente|rostro|cara|chica|señora|abuela|protagonista` (block.ts:687-689)
   - **EXCLUYE** estilos animados: `pixar|cartoon|3d render|illustration|watercolor|animated|comic|claymation|vector art|anime` (block.ts:682-684)
   - **Consume:** Higgsfield DoP (UGC realista), Flux, Veo (video animado UGC)

4. **`other`** — Fallback. Objetos, B-roll, escenas neutras sin persona clara.

### Campo `featuresCharacter`
**Línea:** block.ts:633-636

Flag booleano que indica si la escena muestra al **personaje recurrente** (el narrador o un personaje principal que aparece en varias escenas). Usado por:
- **Cap 2 (image-gen-multi):** Si `featuresCharacter=true` Y tenemos `characterAnchorImage`, se genera anclada a la identidad (image-to-image con referencia) para mantener la misma persona en todo el video (block.ts:139-141 de image-gen-multi).

---

## Campos Emisores

### `textOverlays`
**Línea:** block.ts:54-60 (SceneIdea), contracts:9-27 (TextOverlaySchema)

Array de capas de texto vectorial a renderizar en Remotion ENCIMA de la imagen base. Resuelve el problema sistémico de que los generadores de imagen fallan con texto quemado.

**Shape:**
```typescript
interface TextOverlay {
  kind: 'product-label' | 'day-counter' | 'metric-callout' | 'subtitle-banner';
  text: string;
  position?: 'top' | 'center' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  color?: string;              // hex override
  scale?: number;              // 0.3-3, default 1
}
```

**Crítico:** Cada `TextOverlay` es OPCIONAL. El scene-planner SOLO lo emite si el imagePrompt requiere mostrar texto (producto, métrica, día). **Nunca** como sustituto de la narración.

### `editStep`
**Línea:** block.ts:53, 333-343

Efecto a superponer sobre cuerpo real. OPCIONAL y RARO. **SOLO cuando:**
1. La escena muestra a una **persona o cuerpo REAL** (no CGI, no objetos)
2. Hay un efecto visual **SUPERPUESTO encima** (ej. flujo linfático glowing sobre las piernas)

**Shape:**
```typescript
interface EditStep {
  effectPrompt: string;   // descripción del efecto (ej "glowing amber lymphatic flow")
  region?: string;        // zona: legs, abdomen, face, arms
}
```

**Consumidor:** `image-gen-multi` → `applyEditStep()` (block.ts línea 60-78):
1. Genera imagen BASE (persona real con imagePrompt)
2. Corre EDIT image-to-image (Nano Banana) con prompt que suma el efecto SIN cambiar identidad/pose/fondo

---

## Densidad Visual y Componentes Clave (v3.2)

**Contexto:** Las escenas "pobres" del formato original se debían a que el scene-planner no capturaba la **densidad visual** del estilo (cuántos elementos, qué tan cargada la composición, qué componentes recurrentes enriquecen cada escena).

### `compositionDensity` (Video-Understander, NO scene-planner)
**Ubicación:** `apps/web/lib/video-understander.ts:90-95`

Clasificación del estilo aprendido: `minimalist | moderate | dense | very-dense`. Se usa en `auto-learn-preset.ts:82-91` para **enriquecer el promptTemplate** del preset:

```typescript
if (density !== 'dense' && density !== 'very-dense') return basePrompt;
return `${basePrompt} DENSE, richly detailed, multi-component composition featuring ${keyComponents.join(', ')} — many elements and characters per frame, layered depth, busy and full (NOT minimalist).`;
```

**Punto crítico:** Cuando el scene-planner genera escenas para un preset aprendido, **el promptTemplate YA contiene la instrucción de densidad** (vía `enrichPromptWithDensity()`). El scene-planner usa este `styleBase` como base en cada imagePrompt (block.ts:198-200). Así, sin parámetros adicionales en scene-planner, las escenas NACEN cargadas si el estilo es denso.

### `keyVisualComponents`
**Ubicación:** `apps/web/lib/video-understander.ts:96`

Array de strings (max 12) describiendo elementos/personajes recurrentes que hacen RICO el estilo:
- "multiple anthropomorphic germ characters"
- "body-interior environment with blood vessels"
- "fire/energy effects over skin"

Se inyecta en el enrichedPromptTemplate y, transitivamente, en cada imagePrompt vía el styleBase (block.ts:207-210).

---

## Flujo de Datos End-to-End

```
1. ParsedScript (guión segmentado)
         +
   SubtitleTrack (Whisper word-level, OPCIONAL)
         ↓
   [scene-planner]
         ↓
   2. SceneTrack {
        scenes: [
          {
            text: "línea narrada",
            imagePrompt: "prompt visual LIMPIO (sin texto)",
            textOverlays: [{kind, text, position}],
            componentType: "real-ugc-human",
            featuresCharacter: true,
            speaking: false,
            editStep?: {effectPrompt, region}
          }
        ],
        styleBase: "...",
        narratorProfile: {gender, ageRange, characterCard}
      }
         ↓
   3. [image-gen-multi]
      - Rutea cada escena al provider preferido según componentType
      - Si featuresCharacter + characterAnchorImage, genera anclada a identidad
      - Si editStep, corre EDIT image-to-image
      - Si textOverlays, Remotion las renderiza como capas vectoriales
         ↓
   4. [compositor-remotion]
      - Renderiza imagen/video + textOverlays + anotaciones + audio
```

---

## Wirings No-Obvios

1. **timing word-level vs estimación proporcional:** Si `subtitleTrack` está disponible, **prevalece su duración sobre** la estimación del script (block.ts:111-114). Sin Whisper, fallback a distribución proporcional por length de text.

2. **Anti-collage:** Aunque el styleBase enumere varios momentos/lugares (ej. "espejo, cocina, dormitorio"), el scene-planner elige **UN SOLO** para cada escena. El prompt de estilo describe el LOOK/paleta, NO la lista de momentos (block.ts:276-281).

3. **caracterCard literal:** La descripción del narrador se inyecta **LITERALMENTE** (copy-paste, no parafrasear) en cada prompt que muestre al narrador (block.ts:361-365). Esto asegura consistencia visual (misma persona en todo el video).

4. **speaking ramificación:** El motion-prompt aguas abajo ramifica en `generateWithMotion()` según `speaking`:
   - `true` → talking-head (boca sincronizada)
   - `false` → gesture/ambient (solo gestos, B-roll)

5. **preferredProviderOrder (image-gen):** El `componentType` rútea al mejor provider, pero **NO es obligatorio**. Si el preferido agota cuota, image-gen-multi cae al siguiente del chain (block.ts:110-122 image-gen-multi).

6. **densidad transitiva:** No hay un parámetro "compositionDensity" en scene-planner. La densidad viaja **vía el styleBase del preset**. Si el preset fue aprendido desde un video denso, su promptTemplate ya incluye la instrucción de densidad (vía `enrichPromptWithDensity()` en auto-learn-preset.ts). El scene-planner hereda esa riqueza automáticamente.

---

## Trampas y Huecos Conocidos

1. **Gemini ocasionalmente devuelve {scenes: []}** sin error HTTP (finishReason=SAFETY o MAX_TOKENS, pero con respuesta 200). El retry automático (3x) lo resuelve en ~80% de casos. Si persiste, el preset/script son problemáticos (safety content, duración excesiva).

2. **Text vacío:** Gemini a veces rellena escenas con `text: ""` para cumplir targetSceneCount. El filtrado lo detecta (block.ts:525), pero si quedan 0 escenas, error. Mejor ajustar targetSceneCount a la baja o usar otro preset si el guión es "delicado".

3. **Anatomía:** Pedirle a Imagen que dibuje manos/pies sin instrucción explícita genera dedos faltantes/mal proporcionados. El block.ts:414 inyecta la instrucción de 5 dedos/simetría. DEBE estar en el prompt final.

4. **Anti-embarazo:** La composición tiene prioridad sobre las palabras negativas. "No embarazada" en el prompt NO evita silhuetas maternales si el generador interpreta "vientre hinchado" = pregnancy-shape. El block.ts:247-263 da posiciones EXPLÍCITAMENTE seguras (frente, no perfil; una mano presionando, no acunando).

5. **referenceImages en preset aprendido:** Auto-learn-preset embebe una imagen base en data-URI para que image-gen-multi la use con Nano Banana (image-to-image). Si la imagen es "limpia" sin densidad, el preset nace minimalista. Por eso `pickReferenceFrameIndex()` elige el frame más **REPRESENTATIVO** (denso), no el "más limpio" (block.ts:183-206 auto-learn-preset).

6. **Lecciones aprendidas (lessonsBlock):** El error-memory de runs pasados se inyecta al prompt. Pero a veces **trigger el safety filter por mencionar errores/patterns**. En el último reintento, se remueve (block.ts:449-451). Es un trade-off: más contexto vs riesgo de safety.

---

## Verificación y Validación

**Validación interna:**
- `validateInput()` (block.ts:71-84): Zod parse del ParsedScript
- Filtrado de escenas vacías (block.ts:525-530)
- Timestamp distribution (block.ts:622): asegura que última escena llega a totalDuration exacto

**Validación aguas abajo:**
- **Scene-validator (bloque siguiente):** Verifica anatomía, coherencia narrativa, densidad de personas
- **Quality gate (post-render):** Verifica duración total, cobertura de audio, lipsync

---

## Configuración Mínima para Uso

```typescript
const planner = new ScenePlannerBlock({
  targetSceneCount: 25,  // escenas para 60s de audio
  geminiModel: 'gemini-2.5-pro',
  ownerPreferences: 'La protagonista debe ser mujer de ~50 años, no embarazada. Acuarela cálida.'
});

const result = await planner.run(
  {
    parsedScript: myScript,
    subtitleTrack: whisperOutput  // OPCIONAL pero RECOMENDADO
  },
  blockContext
);
```

Si `result.isOk()`, acceder a:
- `result.value.scenes` — array de escenas
- `result.value.totalDurationSeconds` — duración total
- `result.value.narratorProfile` — perfil del narrador

**⚠️ Gotchas (06-scene-planner: planificación de escenas y enrutamiento por componente visual):**
- timing word-level: Si subtitleTrack está disponible, su duración (endTimeSeconds de la última palabra) reemplaza estimatedDurationSeconds del script. Esto evita cola silenciosa donde escenas y subs siguen mostrándose tras terminar la narración real.
- compositionDensity NO es parámetro directo de scene-planner: viaja vía styleBase del preset. Si el preset fue aprendido desde un video denso, su promptTemplate ya incluye 'DENSE, richly detailed' + keyVisualComponents. El scene-planner hereda esa densidad automáticamente sin parámetros adicionales.
- anti-collage: Aunque styleBase enumere varios momentos ('espejo, cocina, dormitorio'), scene-planner elige UN SOLO momento por escena. La instrucción 'REGLA UN SOLO CUADRO' (block.ts:276-281) es crítica; el regex que detecta split-screen NO genera grillas en imagePrompt.
- characterCard literal: La descripción del narrador se inyecta LITERALMENTE (copy-paste) en cada prompt que muestre al narrador. Esto asegura consistencia visual de la misma persona en todo el video. NO parafrasear.
- textOverlays como solución a gibberish text: Los generadores fallan constantemente con texto (labels en inglés, números rotos). Solución: imagen LIMPIA + textOverlays como capas vectoriales en Remotion. CRÍTICO: una sola mención 'no text' funciona mejor que diez; la negación prima al generador a DIBUJAR texto (paradoja).
- Gemini {scenes: []} sin error HTTP: A veces devuelve respuesta 200 pero con finishReason=SAFETY/MAX_TOKENS y objeto vacío. El retry automático (3x con backoff) lo resuelve ~80%. Si persiste, el preset/guión son problemáticos.
- anti-embarazo: Composición tiene PRIORIDAD. 'No embarazada' negativo en el prompt NO evita silhuetas maternales. Las POSES prohibidas (perfil + vientre redondo, manos acunando) son las que generan esa interpretación. Usar poses SEGURAS: frente, una mano presionando con molestia, ropa apretada (block.ts:247-263).
- referenceImages densidad: Auto-learn-preset embebe una imagen en data-URI para Nano Banana (image-to-image). Si la imagen es 'limpia' sin densidad, el preset nace minimalista. pickReferenceFrameIndex() elige frame REPRESENTATIVO (denso), no 'más limpio'. Esta es la ruta de aprendizaje codificada (auto-learn-preset.ts:188-191).
- lessonsBlock trigger safety: Error-memory de runs pasados se inyecta al prompt. Pero a veces triggea el safety filter (mencionar errores/patterns). En último reintento, se remueve (block.ts:449-451). Trade-off: más contexto vs riesgo de safety.
- deriveComponentType determinista: Sin llamada extra al modelo. Analiza shotType+imagePrompt con regex. El 'animated' (pixar|cartoon) y 'human' (woman|person) son excluyentes: Pixar-woman → 'other', no 'real-ugc-human'. Esto es correcto (persona animada ≠ real).
- preferredProviderOrder no es mandatario: componentType rútea al preferido, pero si agota cuota, image-gen-multi cae al siguiente del chain. Es una PREFERENCIA, no un bloqueo.


---

# Compositor Remotion — Motor de Renderizado de Videos Verticales

## Propósito general

El subsistema compositor-remotion (`packages/blocks/compositor-remotion`) es el motor de renderizado final de Video Factory. Recibe un **RenderJob** (audio + imágenes + guión + subtítulos + escenas opcionalmente ordenadas) y lo transforma en un MP4 1080×1920 a 30fps listo para publicar. Es la pieza que CONVIERTE los assets generados en un video de calidad profesional con opciones avanzadas de composición (multi-capas, overlays, chroma-key, anotaciones, fundidos, subtítulos word-level).

**Rol en el pipeline:**
- Recibe la entrada ya preparada: audio sintetizado o nativo, imágenes/videos generados, subtítulos con timing word-level
- Orquesta 4 tipos de composiciones según el contenido disponible
- Renderiza a través de Remotion (headless Chromium via @remotion/renderer)
- Devuelve un MP4 listo; los logs y metadatos se persisten para auditoría

## Arquitectura end-to-end

### 1. Punto de entrada: `CompositorRemotionBlock`

Archivo: `src/block.ts:9-256`

La clase `CompositorRemotionBlock` implementa la interfaz `Block<RenderJob, RenderJob>` del core. Define:

**Propiedades:**
- `name`: `'compositor-remotion'`
- `version`: `'1.1.0'`
- `description`: describe la función del bloque

**Métodos:**
- `validateInput(input)`: valida que el input sea un RenderJob válido según `RenderJobSchema` (zod)
- `async run(input, ctx)`: orquesta el render; devuelve `Result<RenderJob, BlockError>`

**Flujo de `run()`** (líneas 23-253):
1. Valida que `ctx.preset` exista (necesita `preset.subtitles` y `preset.composition`)
2. Extrae metadatos: fps, resolución [1080, 1920], duración en frames = `durationToFrames(audioTrack.durationSeconds, fps)`
3. Prepara el directorio de output: `mkdir(dirname(outputPath), { recursive: true })`
4. Determina qué composición usar según presencia de tracks:
   - Si `sceneTrack` poblado → `'PlanoEscenas'` (multi-escena)
   - Else si `videoTrack` poblado → `'PlanoAnimado'` (clips de video)
   - Else → `'PlanoFijo'` (imagen única + Ken Burns)
5. Transforma la entrada al formato visual que espera Remotion:
   - **Para PlanoEscenas** (líneas 78-177): mapea cada escena a `SceneVisual`; para composite layouts, proyecta subpaneles a `SubScenePanel`; para composiciones libres, mapea `CompositeElement` a `CompositeElementVisual` convirtiendo paths absolutos a basenames
   - **Para PlanoAnimado** (líneas 178-198): extrae basenames de clips + duraciones
   - **Para PlanoFijo** (líneas 199-217): basename de imagen única
6. Llama a `renderComposition(options)` con el tipo y props calculados
7. Loguea progreso (grano fino cada 2%), captura errores, persiste timestamps

**Mapeo de campos críticos** (líneas 105-129 — composición libre):
```typescript
composition = s.composition.map(el => ({
  id: el.id,
  kind: el.kind,
  imageSrc: el.imagePath ? basename(el.imagePath) : undefined,
  videoSrc: el.videoPath ? basename(el.videoPath) : undefined,
  textColor: el.textColor,  // SIN esto, captions amarillas CapCut salen blancas
  backgroundColor: el.backgroundColor,
  rect: el.rect,
  chromaKey: el.chromaKey,
  annotation: el.annotation,
  // ... resto de propiedades
}))
```

### 2. La función de renderizado: `renderComposition`

Archivo: `src/render.ts:56-103`

**Interfaz:**
```typescript
export async function renderComposition(options: RenderOptions): Promise<RenderResult>
```

**Tipos de opciones** (líneas 22-46):
- `RenderPlanoFijoOptions`: imagen + audio + subtítulos
- `RenderPlanoAnimadoOptions`: clips de video + audio + subtítulos
- `RenderPlanoEscenasOptions`: array de escenas + audio + subtítulos
- `RenderComposicionAvanzadaOptions`: composición compleja (proto)

**Flujo** (líneas 56-103):
1. **Bundle:** `bundle()` compila el código React/Remotion usando webpack. Punto crítico:
   - `entryPoint`: siempre `Root.tsx` (donde se registran todas las composiciones)
   - `publicDir`: se iguala a `workDir` del run → `staticFile('audio.mp3')` resuelve desde ahí
   - Webpack override: alias de extensiones `.js` → `.jsx|.ts|.tsx`
2. **Seleccionar composición:** `selectComposition()` busca por ID ('PlanoFijo', 'PlanoEscenas', etc.) en el bundle
3. **Renderizar:** `renderMedia()` genera el MP4:
   - Codec: H.264
   - Resolución: 1080×1920 (sobrescribe defaults del Composition)
   - FPS: 30 (sobrescribe)
   - `onProgress` callback: reporta [0, 1]
4. **Resultado:** lee tamaño del archivo, calcula duración = `durationInFrames / fps`

### 3. Composiciones: cuatro tipos de renderizado

#### **PlanoFijo** (estático + Ken Burns)

Archivo: `src/compositions/PlanoFijo.tsx`

Props: `{ audioSrc, imageSrc, subtitleTrack, subtitlesConfig, composition }`

**Comportamiento:**
- Renderiza una imagen única (`Img`) de fondo
- Aplica motion Ken Burns (pan + zoom) definido en `composition.kenBurns`
  - `enabled`: activa/desactiva (default false en v3.2 — el usuario lo activa desde editor)
  - `zoomStart` → `zoomEnd`: típicamente 1.0 → 1.15 (zoom out gradual)
  - `panX`, `panY`: píxeles de pan sobre la duración (interpolación lineal)
- Superpone subtítulos word-level (cada palabra se colorea según esté activa: `highlightColor` si ahora se pronuncia, `color` normal si no)
- Audio muted en el `<Audio>` component

**Ken Burns interpolación** (`src/utils.ts:26-46`):
- `interpolateKenBurnsZoom(frame, totalFrames, zoomStart, zoomEnd, enabled)`: lerp lineal del zoom
- `interpolateKenBurnsPan(frame, totalFrames, panEnd, enabled)`: lerp del pan desde 0 hasta `panEnd`

#### **PlanoAnimado** (clips de video secuenciales)

Archivo: `src/compositions/PlanoAnimado.tsx`

Props: `{ audioSrc, videoClipSrcs[], videoClipDurations[], subtitleTrack, subtitlesConfig }`

**Comportamiento:**
- Concatena N clips de video en secuencia con `<Series>`
- Cada `Series.Sequence` dura exactamente su clip duration
- El último frame del último clip se congela si el audio dura más
- Subtítulos word-level encima
- Audio muted (el audio viene de la pista sincronizada)

#### **PlanoEscenas** (multi-escena + composición compleja)

Archivo: `src/compositions/PlanoEscenas.tsx:108-237`

Props: `PlanoEscenasProps` (línea 86-106)

**La composición más poderosa — soporta:**
1. **Imágenes estáticas con Ken Burns** (SceneFrame, línea 243-349)
2. **Videos animados generados por Veo** (OffthreadVideo, línea 258-278)
3. **Composite layouts rígidos** (CompositeFrame, línea 351-428): grid-2x2, grid-3x2, before-after, side-by-side, pip
4. **Composición libre / FreeformComposite** (línea 662-706): motor de edición tipo CapCut con elementos arbitrarios

**Lógica de prioridad por escena** (línea 130-175):
```
Si composición libre (composition.length > 0) 
  → FreeformComposite (ganador: edición libre)
Else si compositeLayout != 'single' && subScenes[]
  → CompositeFrame (grid rígido)
Else
  → SceneFrame (imagen única + movimiento)
```

**Subtítulos y audio globales:**
- Se renderean una sola vez para todo el timeline (línea 122-234)
- `findActiveLine(lines, currentSecond)` localiza la línea activa
- Cada palabra dentro de la línea parpadea entre `color` y `highlightColor` según su timing

**Ken Burns on single images** (SceneFrame):
- Si `videoSrc` existe: OffthreadVideo con zoom muy sutil (1.0 → 1.04) — la animación real viene del video
- Si no: imagen fija con pan/zoom OPT-IN
  - `animatedScenes=true` → agresivo (microMotion: zoom 1.06/0.96 alternado + rotación sutil)
  - `kenBurns=true` → pan clásico (Ken Burns user-activated)
  - Default: imagen congelada (fix jun-2026: el movimiento automático era un bug)

##### **CompositeFrame** — layouts rígidos (línea 368-428)

Renderiza un grid de N paneles. Función `layoutPositionToRect()` (línea 434-532) mapea layout + position → CSS rect:

| Layout | Posiciones | Uso |
|--------|-----------|-----|
| `grid-2x2` | top-left, top-right, bottom-left, bottom-right | 4 paneles iguales |
| `grid-2x2-with-bottom` | top-{left,right}, bottom-{left,right}, bottom-wide | 5 paneles (típico antes/después×2 + producto) |
| `grid-3x2` | top/middle/bottom × left/right | 6 paneles (6 mujeres antes/después) |
| `before-after` | left, right | 2 paneles verticales |
| `side-by-side` | top, bottom | 2 paneles horizontales |
| `pip` | main, pip | grande + chico esquina |

**Renderizado de paneles** (línea 397-424):
- Cada panel = `<div>` con posición absoluta, border 2px negro, sombra
- Imagen dentro con `objectFit: 'cover'`
- TextOverlay vectorial opcional (`PanelTextOverlay`, línea 538-630)
- Zoom global sutil (1.0 → 1.02) para que no se vea estático

##### **FreeformComposite** — composición libre (línea 632-706)

Motor de edición estilo CapCut. Cada elemento (`CompositeElementVisual`) tiene:
- **Posición arbitraria**: `rect = { xPct, yPct, widthPct, heightPct }`
- **Timing**: `startSeconds`, `endSeconds` (opcional; default = duración completa de escena)
- **Capas**: `zIndex` ordena desde atrás (0) hasta frente
- **Transforms**: `rotationDeg`, `opacity`, `cornerRadiusPct`
- **Movimiento**: `fit` (cover|contain|fill), `fadeInFrames`, `fadeOutFrames`

**Lógica de timing** (línea 683-703):
```typescript
if (hasStart || hasEnd) {
  // Envuelve en Sequence relativo a inicio de escena
  const fromFrame = hasStart ? Math.round(startSeconds * fps) : 0;
  const seqDuration = hasEnd ? ... : (durationInFrames - fromFrame);
  return <Sequence from={fromFrame} durationInFrames={seqDuration}><FreeformElement/></Sequence>;
}
// Sin timing → dura toda la escena
```

**FreeformElement** (línea 710-860):

Renderiza un único elemento según su tipo:

1. **kind: 'image'**
   - Normal: `<Img src={staticFile(imageSrc)} style={{ objectFit: fit }} />`
   - Con chroma-key: SVG + filter SVG `feColorMatrix` + `feComponentTransfer` + `feMorphology` (línea 768-800)
     - Matriz: `values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  -2 4 -2 0 0"` (greenness = -2R +4G -2B)
     - feFuncA: ramp de alfa invertida (gd alto → transparente)
     - feMorphology erode: come 1.6px para limpiar borde verde

2. **kind: 'video'**
   - `<OffthreadVideo transparent={isWebmAlpha || hasChromaKey} />`
   - Nota: el filtro SVG url() NO resuelve fiable en render headless; se prefire pre-keying a .webm con alpha real (vp9 yuva420p)
   - MUTED siempre (el audio viene de la pista de audio global)

3. **kind: 'text'**
   - `<div>` con `fontFamily: 'Inter'`, `fontWeight: 900`, color `textColor`, tamaño relativo a altura de rect
   - Si `backgroundColor`: fondo sólido + border-radius + shadow (etiqueta)
   - Sin fondo: contorno negro grueso (look UGC/CapCut)

4. **kind: 'annotation'**
   - Círculo + flecha (dibujo SVG) renderizado en capa aparte (`AnnotationLayer`, línea 865-924)
   - Circulo: `<ellipse>` con `strokeDasharray` animado (stroke-dashoffset = circ * (1 - draw))
   - Flecha: línea + cabeza de triángulo (solo aparece si draw > 0.9)
   - Animación: `interpolate(frame, [0, 18], [0, 1])` — los primeros 18 frames dibujan la forma

**Fundidos por elemento** (línea 733-738):
```typescript
const fadeIn = element.fadeInFrames ?? 5;    // entrada suave (default 5 frames)
const fadeOut = element.fadeOutFrames ?? 0;  // salida (default 0 = sin desvanecido)
const enterOpacity = fadeIn > 0 ? Math.min(1, localFrame / fadeIn) : 1;
const exitOpacity = fadeOut > 0 ? Math.min(1, (durationInFrames - localFrame) / fadeOut) : 1;
```

**Fallback defensivo** (línea 309-333): si `imageSrc` vacío, renderiza placeholder visible (#2a1810 sepia oscuro con "[missing visual]") en vez de transparente, para que el post-render judge lo detecte sin que el usuario vea frame negro silencioso.

#### **ComposicionAvanzada** (proto experimental)

Archivo: `src/compositions/ComposicionAvanzada.tsx` (línea 1-100+)

Prototipo que demuestra primitivos clave pero NO está integrado en el pipeline automático. Soporta:
- Background (video o imagen) + múltiples overlays superpuestos
- Chroma-key (SVG filter inline)
- Captions karaoke
- Anotaciones (flecha + círculo)

**Nota de diseño**: FreeformComposite es la generalización productiva; ComposicionAvanzada es una demostración.

## Entrada/Salida: esquemas clave

### Entrada: `RenderJob` (`contracts/render.schema.ts`)

```typescript
{
  runId: string;          // UUID del run
  brandId: string;        // ID de la marca
  presetId: string;       // ID del preset de estilo
  
  // Datos de contenido
  imagePath: string;      // imagen base (siempre — fallback o keyframe para Veo)
  audioTrack: AudioTrack; // { filePath, durationSeconds, ...}
  subtitleTrack: SubtitleTrack; // { language, words[], lines[] } con timing word-level
  
  // Tracks opcionales (prioridad: sceneTrack > videoTrack > imagePath)
  sceneTrack?: SceneTrack;  // { scenes[], totalDurationSeconds, narratorProfile, speakers[] }
  videoTrack?: VideoTrack;  // { clips[] }
  
  // Hints para renderizado
  animatedScenes?: boolean;  // true = Ken Burns agresivo + zoom dinámico (formato animado)
  kenBurns?: boolean;        // true = pan/zoom Ken Burns clásico (OPT-IN)
  
  // Output
  outputPath: string;
  resolution: [1080, 1920];
  fps: 30;
  
  status: 'pending' | 'rendering' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}
```

### Input a Remotion: `SceneVisual` (PlanoEscenas)

```typescript
interface SceneVisual {
  imageSrc: string;           // basename dentro del publicDir
  durationSeconds: number;
  videoSrc?: string;          // MP4 generado por Veo (opcional)
  textOverlays?: TextOverlay[]; // capas de texto vectorial
  
  compositeLayout?: CompositeLayout; // 'single' | 'grid-2x2' | ...
  subScenes?: SubScenePanel[];       // paneles del grid (si layout != 'single')
  composition?: CompositeElementVisual[]; // composición libre (ganador si poblado)
}

interface SubScenePanel {
  panel: string;      // 'top-left', 'bottom-wide', etc.
  imageSrc: string;   // basename
  textOverlay?: TextOverlay;
}

interface CompositeElementVisual {
  id: string;
  kind: 'image' | 'video' | 'text' | 'annotation';
  imageSrc?: string;
  videoSrc?: string;
  text?: string;
  textColor?: string;           // para captions amarillos CapCut
  backgroundColor?: string;     // fondo sólido
  rect: { xPct, yPct, widthPct, heightPct };
  rotationDeg?: number;
  opacity?: number;
  zIndex?: number;
  fit?: 'cover' | 'contain' | 'fill';
  cornerRadiusPct?: number;
  startSeconds?: number;
  endSeconds?: number;
  fadeInFrames?: number;        // default 5
  fadeOutFrames?: number;       // default 0
  textOverlay?: TextOverlay;
  chromaKey?: { color?: 'green'|'blue'; similarity?: number };
  annotation?: { shape?: 'circle'|'arrow'|'circle-arrow'; color?: string; fromXPct?, fromYPct? };
}

interface TextOverlay {
  kind: 'product-label' | 'day-counter' | 'metric-callout' | 'subtitle-banner';
  text: string;
  position?: 'top' | 'center' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  color?: string;               // hex, default #FFE600 (amarillo Vitaly)
  scale?: number;               // default 1.0
}
```

### Salida: `RenderResult`

```typescript
{
  outputPath: string;     // ruta del MP4 renderizado
  sizeBytes: number;      // tamaño en bytes
  durationSeconds: number; // duración = durationInFrames / fps
}
```

## Subtítulos: word-level kinetic

Los subtítulos en Video Factory son **word-level** (cada palabra con timing individual). El compositor los renderea como capas HTML sobre el video, con cada palabra cambiando de color mientras se pronuncia (look TikTok/Reels).

**Datos** (`contracts/subtitle.schema.ts`):
```typescript
interface SubtitleTrack {
  language: string;
  words: SubtitleWord[]; // { word, startTimeSeconds, endTimeSeconds }
  lines: SubtitleLine[]; // { text, startTimeSeconds, endTimeSeconds, wordRefs: index[] }
}
```

**Renderizado**:
1. `findActiveLine(lines, currentSecond)` → localiza la línea activa en el tiempo actual
2. Dentro de esa línea, itera sus `wordRefs` (índices en el array `words`)
3. Para cada palabra, `isWordActive(word, currentSecond)` → color activo o normal
4. CSS: `transition: 'color 60ms linear'` → suave parpadeo

**Posición vertical**: configurable por `subtitlesConfig.position`:
- `'top'`: 12% from top
- `'center'`: 50% (centered vertically)
- `'bottom'`: 15% from bottom (default)

## Archivos y funciones clave con archivo:línea

| Concepto | Archivo:Línea |
|----------|---------------|
| **Block principal** | `src/block.ts:9-256` |
| Validación input | `src/block.ts:15-21` |
| Orquestación run | `src/block.ts:23-253` |
| Mapeo composición libre | `src/block.ts:105-129` |
| **Renderer Remotion** | `src/render.ts:56-103` |
| Bundle + select | `src/render.ts:59-76` |
| Render media | `src/render.ts:78-93` |
| **Composición PlanoFijo** | `src/compositions/PlanoFijo.tsx` |
| Ken Burns interpolation | `src/utils.ts:26-46` |
| **Composición PlanoAnimado** | `src/compositions/PlanoAnimado.tsx` |
| Series + clips | `src/compositions/PlanoAnimado.tsx:43-72` |
| **Composición PlanoEscenas** | `src/compositions/PlanoEscenas.tsx:108-237` |
| Selección composición por escena | `src/compositions/PlanoEscenas.tsx:130-175` |
| **SceneFrame** (single image) | `src/compositions/PlanoEscenas.tsx:243-349` |
| Ken Burns on statics | `src/compositions/PlanoEscenas.tsx:280-297` |
| Fallback placeholder | `src/compositions/PlanoEscenas.tsx:309-333` |
| **CompositeFrame** (grids) | `src/compositions/PlanoEscenas.tsx:368-428` |
| Layout CSS mapping | `src/compositions/PlanoEscenas.tsx:434-532` |
| **FreeformComposite** | `src/compositions/PlanoEscenas.tsx:662-706` |
| Timing + Sequence | `src/compositions/PlanoEscenas.tsx:683-703` |
| **FreeformElement** | `src/compositions/PlanoEscenas.tsx:710-860` |
| Kind dispatch | `src/compositions/PlanoEscenas.tsx:765-856` |
| Chroma-key SVG | `src/compositions/PlanoEscenas.tsx:768-800` |
| **Annotations** (círculo+flecha) | `src/compositions/PlanoEscenas.tsx:865-949` |
| Animation stroke-dashoffset | `src/compositions/PlanoEscenas.tsx:880-909` |
| **Subtítulos word-level** | `src/compositions/PlanoEscenas.tsx:186-234` |
| findActiveLine | `src/utils.ts:3-10` |
| isWordActive | `src/utils.ts:12-14` |
| **Text overlays** | `src/compositions/PlanoEscenas.tsx:955-1122` |
| Estilos por kind | `src/compositions/PlanoEscenas.tsx:1007-1108` |
| **Registro Remotion** | `src/compositions/Root.tsx:70-113` |
| **Re-render** | `apps/web/lib/rerender-composition.ts:34-106` |
| Editor → render job | `apps/web/lib/rerender-composition.ts:54-62` |

## Estado real y capacidades soportadas vs. emitidas

### Motor SOPORTA

✓ **Composición libre** (FreeformComposite): elementos arbitrarios, zIndex, timing por pieza, rotación, opacidad, cornerRadiusPct, fit modes
✓ **Chroma-key**: green/blue, pre-keying a webm alpha, SVG filter fallback
✓ **Anotaciones**: círculo, flecha, circle-arrow, timing animado (draw 0→1 en 18 frames)
✓ **Multi-audio**: campo `speakerId` ya existe en Scene schema; el compositor MUTEA y reproduce de pista global
✓ **Fundidos**: por elemento (fadeInFrames, fadeOutFrames), entre escenas (sceneTransitions opt-in)
✓ **Ken Burns**: OPT-IN (junio 2026: cambio crítico — default false)
✓ **Motion escenas animadas**: OffthreadVideo (Veo) + subtle zoom; animatedScenes flag para Ken Burns agresivo
✓ **Texto vectorial**: product-label, day-counter, metric-callout, subtitle-banner; posicionable globalmente y por panel
✓ **Composite layouts**: grid-2x2, grid-3x2, grid-2x2-with-bottom, before-after, side-by-side, pip
✓ **Subtítulos word-level**: highlighting por palabra durante narración
✓ **Texturas y filtros**: corner-radius, box-shadow, text-stroke (fake vía text-shadow)

### Pipeline EMITE (actualmente)

✓ Escenas estáticas + imagen única per escena
✓ 1 TTS único (un narrador)
✓ Fondos simples (sin overlays)
✓ Subtítulos básicos (no sincronizados siempre a palabra)
✗ **NO emite** composiciones libres automáticas (falta Fase 2 — detector de geometría exacta)
✗ **NO emite** anotaciones sincronizadas (falta word-sync integrado)
✗ **NO emite** PiP automático
✗ **NO emite** multi-voz por hablante (speakerId en Scene ya existe, pero TTS no ramifica)

**Nota de arquitectura**: el motor ya SOPORTA todo lo anterior. Para automatizar un formato complejo (ej. SuperCalm doctor-split) hay que EXTENDER el pipeline para EMITIR esas composiciones, NO rebuildear el motor.

## Re-render (Fase 3 — edición manual)

Archivo: `apps/web/lib/rerender-composition.ts:34-106`

**Propósito**: re-generar el video de un run SOLO con el compositor, reutilizando audio e imágenes existentes. Se dispara cuando el usuario edita la composición manualmente en el editor.

**Flujo**:
1. Lee el `render-job.json` persistido por el pipeline
2. Lee el `scene-plan.json` EDITADO por el editor de composición
3. Inyecta el `sceneTrack` actualizado en el render job
4. Corre `compositorRemotion.run(newJob, ctx)` → solo Remotion, cero APIs de generación
5. Actualiza status del run a 'completed'

**Ventajas**:
- Barato (1-3 min vs. 20-40 min de un rip completo)
- No regenera imágenes ni audio
- Ideal para ajustes de posición, timing, opacidad, etc.

**Parámetros opcionales**:
- `opts.kenBurns`: true/false para override del flag de Ken Burns

## Wirings no-obvios

1. **publicDir = workDir**: En `renderComposition()` línea 61, `publicDir: options.workDir`. Esto significa que `staticFile('audio.mp3')` en Remotion busca en el directorio del run, no en `public/` del proyecto. Es por diseño: cada run tiene su propia carpeta con assets.

2. **Basename OBLIGATORIO**: El bloque convierte paths absolutos (`imagePath: '/storage/...') a basenames antes de pasar a Remotion (línea 41, 110, 139, 200, 412). Remotion nunca ve rutas absolutas.

3. **textColor CRÍTICO**: Sin pasar `el.textColor` del `CompositeElement` al `CompositeElementVisual` (línea 115), las captions amarillas CapCut se renderizan blancas en silencio — el color por defecto de Remotion es blanco. Bug histórico resuelto.

4. **Prioridad de tracks**: En el bloque (línea 45), la lógica es: `sceneTrack > videoTrack > imagePath`. Si el run tiene escenas, se usa PlanoEscenas incluso si hay videoTrack presente.

5. **Ken Burns default OFF** (jun-2026): Antes, el movimiento automático (microMotion) se aplicaba siempre en SceneFrame. Junio 2026: cambio crítico — default `kenBurns: false`. El usuario lo activa EXPLÍCITAMENTE desde el editor o via API. Esto evita "movimiento no solicitado" que se sentía invasivo.

6. **animatedScenes vs. kenBurns**: Son flags DISTINTOS:
   - `animatedScenes`: agresivo + rotación sutil (formatos 'b-roll-animated', 'voiceover-animated')
   - `kenBurns`: pan/zoom clásico lineal (OPT-IN del usuario)
   - Ambos pueden estar activos, pero son controlados independientemente

7. **Chroma-key: SVG inline vs. pre-keying**: El compositor soporta ambos:
   - **SVG inline** (FreeformElement, línea 768-800): `feColorMatrix` + `feComponentTransfer` para recorte en render headless. Funciona bien si la similitud es alta.
   - **Pre-keying a webm alpha**: Mejor para video (OffthreadVideo no resuelve filtros url()), requiere pre-procesar frames con keying+despill en C# + ffmpeg a vp9 yuva420p.

8. **OffthreadVideo es MUTED**: Siempre (línea 273, 808, 821). El audio NUNCA viene del video; siempre de la pista de audio global (`audioSrc`). Esto asegura sincronía perfecta y elimina el riesgo de audio desincronizado si el video tiene audio nativo.

9. **Timing relativo en Sequence**: En FreeformComposite (línea 686), `startSeconds` y `endSeconds` son relativos al INICIO de la escena, NO absolutos del timeline global. Esto facilita edición: "el elemento aparece a los 2 segundos de esta escena".

10. **Anotaciones animadas en primeros 18 frames**: El círculo se dibuja progresivamente (stroke-dashoffset), completándose en frame 18 (línea 880). La flecha aparece solo si draw > 0.9 (línea 941). Es un efecto visual que enfatiza la anotación sin distraer.

11. **Placeholder defensivo #2a1810**: Si imageSrc vacío en SceneFrame (línea 309), renderiza un color sepia oscuro (#2a1810) con texto "[missing visual · scene N]". Esto permite que el post-render judge detecte visualmente la escena faltante sin que el usuario vea un frame negro silencioso. Bug fix 25-may-2026.

12. **Grid gap small (4px equivalente)**: En CompositeFrame, el gap entre paneles es de ~4px (`layoutPositionToRect`, línea 436). Border 2px + gap pequeño = look TikTok típico de ads splitscreen.

13. **PanelTextOverlay scale factor 0.55**: En PanelTextOverlay (línea 539), el texto dentro de un panel se escala al 55% del tamaño global (`overlay.scale * 0.55`). Esto asegura que los labels dentro de paneles chicos sean legibles sin comerse la imagen.

14. **Ken Burns en PlanoFijo vs. SceneFrame**: Comportamiento distinto:
    - PlanoFijo: lee config de `composition.kenBurns` (preset)
    - SceneFrame: respeta el flag `kenBurns` del RenderJob + `animatedScenes` para modo agresivo

15. **Text stroke fake via text-shadow**: `buildTextShadow()` (línea 1135) genera offsets en 8 direcciones para simular contorno. Más portable que `-webkit-text-stroke` en headless.

## Limitaciones y edge cases

1. **Chroma-key imperfecto en headless**: El filtro SVG `feColorMatrix` funciona bien pero NO es tan preciso como un keyer dedicado (gd > similar). Para videos animados con spill verde, pre-keying a alpha real es más confiable.

2. **Fuentes limitadas**: Las fuentes disponibles en headless son las del sistema + las instaladas. Remotion cachea las fuentes compiladas; fuentes custom (Google Fonts) requieren config extra en webpack.

3. **Performance**: Renders largos (>3 min) pueden ser lentos. Remotion es eficiente pero los filtros SVG complejos y muchos elementos (`zIndex` alto) ralentizan.

4. **Subtítulos no soportan markup**: Los `subtitles` son text plano. No hay negrita, italica, ni cambio de tamaño inline.

5. **Composición libre sin grid snap**: Los elementos de FreeformComposite se posicionan a píxel exacto (% del frame). No hay snap-to-grid automático.

6. **Video sin alpha en OffthreadVideo**: Si intentas renderear un video con `transparent=true` pero el archivo no tiene alpha, Remotion lo ignora y muestra el fondo original (o negro si no hay fallback).

## Testing

Archivo: `test/utils.test.ts`

Tests unitarios para funciones de utilidad:
- `findActiveLine()`: localización de línea activa + boundary conditions ([start, end) semantics)
- `isWordActive()`: timing de palabras
- `clampedProgress()`: interpolación acotada [0, 1]
- `interpolateKenBurnsZoom()` / `interpolateKenBurnsPan()`: interpolación lineal
- `durationToFrames()`: conversión duración → frames

Todos los tests verifican edge cases (0, negativo, empty arrays, etc.).

## Integración con el sistema mayor

1. **Input**: El block recibe RenderJob de `pipeline.ts` (apps/web/lib). El pipeline orquesta los pasos previos (TTS, generación de imágenes, validación).

2. **Persistencia**: El render-job.json se persiste en `workDir` por el pipeline, permitiendo re-render posterior (editor).

3. **Output**: El MP4 se guarda en `input.outputPath` (típicamente `${workDir}/final.mp4`). La metadata se persiste en la DB del run.

4. **Validación**: Tras render, el post-render-judge (M5) valida el video con Gemini Vision. Las anotaciones, texto, duración y cobertura se auditan.

5. **Correcciones**: Si el judge detecta un defecto (ej. anotación desincronizada), el repair-executor puede regenerar UNA escena via `rerenderComposition()` (Fase 2 de auditoría).

---

**Documento generado**: referencia completa del compositor-remotion para que un Claude nuevo entienda el motor sin sorpresas.

**⚠️ Gotchas (07-compositor-remotion):**
- Ken Burns default OFF (jun-2026): no apliques movimiento automático a menos que kenBurns:true o animatedScenes:true. El usuario lo activa explícitamente. Antes era un bug—el movimiento se sentía invasivo.
- textColor CRÍTICO: sin pasar el textColor del CompositeElement al CompositeElementVisual, las captions amarillos CapCut salen blancas en silencio. Bug histórico (línea 115 del block.ts).
- publicDir = workDir siempre: staticFile('audio.mp3') busca en el workDir del run, no en public/. Es por diseño—cada run tiene su carpeta de assets.
- Basenames OBLIGATORIOS: el block convierte paths absolutos a basenames antes de pasar a Remotion (líneas 41, 110, 139, 200, 412). Remotion nunca ve rutas absolutas.
- OffthreadVideo es MUTED SIEMPRE: el audio viene de la pista global (audioSrc), nunca del video. Garantiza sincronía perfecta y evita audio desincronizado.
- Chroma-key SVG funciona bien en headless pero NO es tan preciso como keying dedicado. Para video con spill, pre-keying a webm alpha (vp9 yuva420p) es más confiable.
- Timing en FreeformComposite es relativo a la escena, no global: startSeconds/endSeconds son desde el inicio de esa escena, facilitando edición.
- Anotaciones dibujan en primeros 18 frames (draw interpolate 0→1): no aparecen instantáneamente. La flecha solo si draw > 0.9.
- Prioridad de tracks: sceneTrack > videoTrack > imagePath. Si hay escenas, usa PlanoEscenas incluso si hay videoTrack.
- PanelTextOverlay escala al 55%: el texto dentro de un panel se reduce al 55% del tamaño global para ser legible en paneles chicos.
- Grid gap 4px: el espacio entre paneles en CompositeFrame es pequeño, imitando look TikTok typical de splitscreen ads.
- Placeholder defensivo #2a1810: si imageSrc vacío, renderiza color sepia oscuro en vez de transparente/negro, permitiendo que el judge lo detecte. Bug fix 25-may-2026.
- Ken Burns en PlanoFijo lee config del preset (composition.kenBurns), no del RenderJob. animatedScenes es para SceneFrame (modo agresivo).
- Fuentes limitadas en headless: las fuentes disponibles son del sistema. Custom fonts (Google Fonts) requieren webpack config.
- Video sin alpha con transparent=true: si el archivo no tiene alpha, se ignora el flag y se muestra el fondo original.
- Composición libre sin snap-to-grid: los elementos se posicionan a píxel exacto (% del frame), no hay snap automático.
- Subtítulos no soportan markup: no hay negrita, italica, ni tamaño inline—solo text plano con color dinámico.
- sceneTransitions default true: pero en composición libre puedes desactivarlo (sceneTransitions=false) para que no abra en negro. Usado en tramos de 1 sola escena.
- FADE_FRAMES cambia con animatedScenes: default 4, pero 6 si animatedScenes=true (suaviza transiciones entre clips animados).
- Composite layout fallback: si el aligner falla en generar paneles (subScenes vacío), degrada automáticamente a layout 'single' (imageSrc principal).
- Recorte de video pre-keying: el filtro SVG url() NO resuelve fiable en OffthreadVideo render headless (sale negro). Solución: pre-procesar a webm con alpha real + OffthreadVideo transparent.


---

# 08-Compuerta de Jueces (Quality Gate + Validadores)

## Propósito

Subsistema de **auditoría y validación determinista** de videos generados. Diseñado en capas (Lente B+C del círculo de mejora):

- **Lente B: Panel multi-agente CON VISIÓN** (`format-audit.ts`) — 6 especialistas + juez Gemini video+audio inspeccionan keyframes y audio del render vs original, emitiendo hallazgos estructurados.
- **Lente C: Juez Forense AV Gemini** (`render-quality-judge.ts`, Fase 2) — Gemini 2.5 Pro ve+oye el render temporal completo y detecta defectos AV finos (lipsync, ritmo, anatomía, audio, empalmes).
- **Compuerta determinista** (`quality-gate.ts`) — Función pura (sin IA) que traduce hallazgos a veredicto (`pass`/`revisar`/`fail`) según política. Incluye:
  - Rúbrica derivada del formato (criterios específicos del estilo aprendido).
  - Localización hallazgo→escena (Fase 2: habilita reparación dirigida).
  - Guardián de español neutro (bloquea voseo, rule crítica del owner).
  - Fail-closed del juez AV (si falla Gemini, veredicto→`revisar` automáticamente).

No auto-aplica nada: solo PROPONE. El resultado se persiste (findings.jsonl) y se refleja a la KB (eventos).

---

## Arquitectura end-to-end

```
RENDER o APRENDER VIDEO
         ↓
   runQualityGate(input)  [quality-gate.ts:601]
         ↓
    [Resolver paths]
    render: <RUNS_DIR>/<runId>/final.mp4 (o directo via renderVideoPath)
    original: opcional (referencia de fidelidad, voces, animación)
         ↓
    [Derivar RÚBRICA si analysis presente]
    → deriveRubric(analysis, plan, motion?)  [quality-gate.ts:172]
      (determinista, hermano de planTimelineFromFormat)
      Emite criterios específicos del formato por dimensión
         ↓
    [Componer contextText del panel]
    → serializeRubricForPrompt(rubric)  [quality-gate.ts:359]
      (rúbrica serializada antepuesta a contextText)
         ↓
    [Orquestador: especialistas + Gemini judge (opt-in)]
    runFormatAudit(input)  [format-audit.ts:267]
         ├─ Carga keyframes (render + original)
         ├─ Resuelve motion-map (animado vs estático)
         ├─ Corre especialistas (6 dimensiones):
         │   • composicion-recorte (render)
         │   • animacion-movimiento (original + motion-map)
         │   • voces-diarizacion (original + context)
         │   • producto-legibilidad (render)
         │   • captions-anotacion (render)
         │   • fidelidad (render vs original)
         │
         ├─ [FASE 2 opt-in] Enchuf Gemini judge como especialista extra:
         │   • renderQualityJudge(render, original)  [render-quality-judge.ts:166]
         │     - Ve+oye el render temporal
         │     - Emite hallazgos en formato SpecialistOutput
         │     - Devuelve MISMO schema que especialistas
         │     - Verificador propio (no refuta sin evidencia AV)
         │
         ├─ Verifica high/critical (adversarial, mata falsos positivos)
         ├─ Persiste hallazgos (findings.jsonl, subsistema 'aprendizaje')
         └─ Refleja a KB como Eventos
         ↓
    [LOCALIZACIÓN hallazgo→escena — Fase 2 "el brazo"]
    loadRunSceneTimings(runId)  [quality-gate.ts:481]
    → lee scene-plan.json del run
    → mapea startSec → escena que la cubre
    → enriquece hallazgos con sceneIndex  [quality-gate.ts:703]
         ↓
    [DECISIÓN DETERMINISTA]
    decideGateVerdict(result, policy)  [quality-gate.ts:522]
    → cuenta hallazgos contables (estado='confirmado' o 'abierto' si countUnverified)
    → aplica política (failOn=critical, reviewOn=high, reviewOnMediumCount=3)
    → emite veredicto + bloqueantes + recomendaciones
         ↓
    [FAIL-CLOSED del juez AV]
    if (juez render-av falló && veredicto ≠ 'fail')
      → degradar a 'revisar' con bloqueante sintético  [quality-gate.ts:730]
         ↓
    [GUARDIÁN DE ESPAÑOL NEUTRO]
    detectVoseo(contextText)  [quality-gate.ts:753]
    → si se detecta voseo/regionalismos → FAIL automático  [quality-gate.ts:754]
         ↓
    [PERSISTE VEREDICTO]
    writeQualityGateReport(report)  [findings.ts:202]
         ↓
QualityGateReport {
  gateId, scope, label, ts,
  veredicto: 'pass'|'revisar'|'fail',
  bloqueantes: [GateBlocker...],  // lo que bloquea
  recomendaciones: [GateBlocker...],  // lo que se recomienda
  resumen: string,  // frase final para el owner
  auditId, policy, especialistasAuditados, errores
}
```

---

## Componentes clave

### 1. `quality-gate.ts:runQualityGate(input)`

**Función principal** que orquesta la compuerta. Resuelve:
- Rutas del render (via runId o path directo).
- Derivación de rúbrica (si `analysis` presente sin `rubric`).
- Inyección de Gemini judge (si `useGemini:true` o env `VF_GATE_USE_GEMINI=1`).
- Localización hallazgo→escena (lee scene-plan.json del run).
- Decisión determinista del veredicto.
- Guardián de español neutro (detectVoseo, bloquea voseo).
- Fail-closed del juez AV.
- Persistencia del reporte.

**Entrada:**
```typescript
QualityGateInput {
  runId?: string;  // → resuelve <RUNS_DIR>/<runId>/final.mp4
  renderVideoPath?: string;  // alternativa directa
  renderKeyframePaths?: string[];
  originalVideoPath?: string;  // para fidelidad, voces, animación
  label?: string;  // etiqueta legible
  contextText?: string;  // narración, transcripción, preset
  rubric?: Rubric;  // derivada del formato aprendido (opcional)
  analysis?: AdAnalysis;  // si presente + no rubric → DERIVA rúbrica
  plan?: FormatTimelinePlan;  // requerida para derivar rúbrica
  motion?: { cuts: number[]; animatedPct: number };  // mapa animado/estático
  depth?: 'rapido' | 'profundo';  // Haiku (default) | Sonnet
  useGemini?: boolean;  // activar juez AV (default: env VF_GATE_USE_GEMINI)
  policy?: Partial<GatePolicy>;  // override de política
  deps?: FormatAuditDeps;  // inyección para tests
}
```

**Salida:** `QualityGateReport` con veredicto, bloqueantes, recomendaciones, resumen.

### 2. `quality-gate.ts:deriveRubric(analysis, plan, motion?)`

**Función determinista** que genera una rúbrica específica del formato aprendido. Hermana de `planTimelineFromFormat` (mismo patrón derivativo).

**Lógica:**
- Lee `plan.componentsToGenerate` → emite criterios de voces-diarizacion (nº de voces distintas).
- Lee `plan.segments[role]` → emite criterios de animación (experto a cámara, lipsync nativo, mezcla animado/estático).
- Lee `analysis.product` → emite criterios de producto-legibilidad.
- Lee `analysis.visualStyleProfile.textOverlayStyle` → emite criterios de captions.
- Detecta `isBeforeAfterFormat(analysis)` → emite criterio global de antes/después (hinchada, no golpeada, progresión).
- Incluye `motion.animatedPct` y `motion.cuts` → emite criterios de ritmo.

**Anti-falsos-positivos:** nunca deriva criterio cuyo soporte sea null (sin producto → sin criterio).

**Salida:**
```typescript
Rubric {
  formatLabel: string;
  criteria: RubricCriterion[];  // dimensión, peso (1-5), severidad de corte
  byDimension: Record<RubricDimension, RubricCriterion[]>;
  requiredComponents: string[];  // de plan.componentsToGenerate
  acceptanceSummary: string;
}
```

### 3. `quality-gate.ts:decideGateVerdict(result, policy)`

**Función pura** (sin IA, determinista, testeable) que traduce hallazgos a veredicto.

**Política:** `GatePolicy`
```typescript
{
  failOn: 'critical' | 'high';  // severidad mínima que lanza 'fail'
  reviewOn: 'medium' | 'high';  // severidad mínima que lanza 'revisar'
  reviewOnMediumCount: number;  // nº de 'medium' que disparan 'revisar' (default 3)
  countUnverified: boolean;  // si true, 'abierto' cuenta igual que 'confirmado' (fail-safe)
}
```

**Lógica:**
```
1. Filtra hallazgos contables (estado='confirmado' o 'abierto' si countUnverified)
2. Cuenta por severidad
3. if (∃ high/critical ≥ failOn)  → veredicto='fail', bloqueantes=[failers+reviewers]
   elif (∃ high/critical ≥ reviewOn OR mediumCount ≥ reviewOnMediumCount)  → veredicto='revisar'
   else → veredicto='pass'
4. Ordena bloqueantes por severidad (desc) y confianza (desc)
5. Recomendaciones = hallazgos contables que no son bloqueantes
```

**Salida:**
```typescript
{
  veredicto: 'pass' | 'revisar' | 'fail';
  bloqueantes: GateBlocker[];  // lo que dispara el veredicto
  recomendaciones: GateBlocker[];  // lo opcional, surface-only
  resumen: string;  // una frase para el owner
}
```

### 4. `format-audit.ts:runFormatAudit(input)`

**Orquestador del panel multi-agente CON VISIÓN.** Reusa schemas de `deep-audit.ts` pero especializado para formato (6 especialistas CON visión de keyframes).

**Especialistas:**

| Dimensión | Usa | Brief |
|-----------|-----|-------|
| composicion-recorte | render | Busca: halo/fleco, bordes sucios, overlay fuera de lugar, "pegado" |
| animacion-movimiento | original + motion-map | Analiza QUÉ/QUIÉN se mueve (experto, usuaria, producto) en cada tramo |
| voces-diarizacion | original + context | Detecta nº hablantes distintos, rol, género |
| producto-legibilidad | render | Busca: ausente, ilegible, mal integrado (luz/escala/sombra) |
| captions-anotacion | render | Busca: subtítulos sin contorno, anotaciones sin anclaje/sincronía |
| fidelidad | render vs original | Compara FORMATO (estructura, encuadres, ritmo, paleta) |

**Flujo:**
1. Extrae keyframes (render y original) vía ffmpeg o de paths.
2. Construye motion-map del original (animado vs estático).
3. Corre especialistas con unifiedJudge (Claude multimodal) sobre keyframes.
4. [FASE 2] Enchuf especialista extra: juez Gemini render-av.
5. Verifica high/critical (adversarial, mata falsos positivos).
6. Persiste hallazgos + refleja a KB como Eventos.
7. Síntesis IA (dedup, ranking, proximoPaso).

**Entrada:**
```typescript
FormatAuditInput {
  scope: string;  // runId / presetId / etiqueta
  label: string;  // nombre legible
  renderVideoPath?: string;
  originalVideoPath?: string;
  renderKeyframePaths?: string[];
  originalKeyframePaths?: string[];
  contextText?: string;  // entendimiento del original, preset
  specialists?: string[];  // override qué especialistas correr (default: todos)
  depth?: 'rapido' | 'profundo';  // Haiku | Sonnet
  maxVerificaciones?: number;  // default 8
  deps?: FormatAuditDeps;  // inyección para tests
}
```

**Inyección de especialistas extra:**
```typescript
extraSpecialists?: Array<{
  especialista: string;
  run: (args: { contextText: string; model: string }) => Promise<SpecialistOutput | null>;
  verify?: (args: {
    subsistema: string;
    draft: HallazgoDraft;
    model: string;
  }) => Promise<Verificacion | null>;  // verificador AV-aware (optional)
}>
```

**Salida:** `FormatAuditResult` con auditId, hallazgos persistidos, sintesis, errores.

### 5. `render-quality-judge.ts:renderQualityJudge(opts)`

**Juez Gemini video+audio**, especialista de Fase 2. Ve+oye el render TEMPORAL completo.

**System instruction:**
- POSTURA: ADVERSARIAL pero HONESTA. Busca defectos activamente, pero NO inventa.
- IDIOMA: español neutro (con "tú"). Prohibido voseo.
- ANCLA TEMPORAL: duración exacta del render = hard constraint. Tiempos clampeados a [0, duraciónReal].
- DIMENSIONES (si rúbrica los marca activos):
  1. **realismo** — ¿se ve creíble y NO "de IA"? Caras deformes, texturas plásticas, flicker, uncanny valley.
  2. **lipsync** — ¿labios coinciden con audio (fonemas+timing)?
  3. **fidelidad-al-original** — ¿reproduce el FORMATO (estructura, encuadres, densidad de cortes, ritmo, paleta)?
  4. **ritmo-cortes** — ¿buen pulso vertical (cortes cada ~2-6s)?
  5. **producto-legible** — ¿visible, integrado (luz/escala/sombra), etiqueta/marca/claim LEGIBLE en móvil?
  6. **persona-se-ve-bien** — En antes/después: "antes" hinchada (no golpeada), MEJORÍA progresiva.
  7. **recorte-composicion** — ¿bordes limpios, sin halo/fleco, escala/posición naturales?
  8. **anotacion-sincronizada** — ¿ancladas a zona exacta, SINCRONIZADAS a narración?

**AUDITORÍA FORENSE DE MICRO-ERRORES (siempre):**
- **Transiciones/cortes:** jump cut, crossfade sucio, parpadeo, overlay que aparece/desaparece sin entrada/salida.
- **Audio:** clicks/pops, volumen inconsistente, respiraciones audibles, sibilancia, corte abrupto.
- **Anatomía:** dedos deformes, morphing, ojos raros, flicker.
- **Oclusiones:** overlay que tapa cara/rasgo importante.
- **Estabilidad overlays:** PiP que salta de tamaño/posición.
- **Legibilidad:** texto cortado, ilegible en móvil.

**Entrada:**
```typescript
RenderQualityJudgeOptions {
  renderVideoPath: string;  // OBLIGATORIO
  originalVideoPath?: string;  // opcional (solo fidelidad)
  contextText?: string;  // narración, contexto
  rubric?: Rubric;  // dimensiones activas + severidad de corte
}
```

**Salida:** `SpecialistOutput` (mismo schema que especialistas de panel):
```typescript
{
  resumen: string;
  hallazgos: Array<{
    titulo: string;
    severidad: 'low' | 'medium' | 'high' | 'critical';
    descripcion: string;  // qué está mal
    evidencia: string;  // qué se ve/oye
    fixPropuesto: string;  // cómo arreglarlo
    confianza: 0.0-1.0;
    startSec: number | null;  // segundo donde empieza el defecto
  }>;
}
```

**Anti-alucinación:**
- `probeVideoDurationSec()` mide duración exacta con ffprobe.
- `clampTimesInText()` reescribe tiempos fuera de rango SOLO en formas inequívocamente temporales:
  - `(N s)` / `(Ns)` entre paréntesis.
  - `t=Ns`.
  - `segundo N` / `segundos N`.
  - `Ns` suelto (NO `ms`, que es milisegundos).

### 6. `format-audit.ts` + `deep-audit.ts:SpecialistOutputSchema`

**Schemas robustos** que TRUNCAN en vez de rechazar:
```typescript
HallazgoDraftSchema: {
  titulo: string (≤160 chars),
  severidad: 'low'|'medium'|'high'|'critical' (.catch('medium')),
  descripcion: string (≤1200 chars),
  evidencia: string (≤800 chars),
  fixPropuesto: string (≤800 chars),
  confianza: 0.0-1.0 (.catch(0.5)),
  startSec: number | null (.catch(null), opcional)
}

SpecialistOutputSchema: {
  resumen: string (≤600 chars),
  hallazgos: HallazgoDraft[] (max 12)
}
```

### 7. `neutral-es.ts:detectVoseo(text)`

**Guardián de español neutro.** Detecta formas voseo/regionales del mapa VOSEO_MAP:
- Imperativos acentuados: `mirá`→`mira`, `hacé`→`haz`, `vení`→`ven`, etc.
- Presente 2ª voseo: `tenés`→`tienes`, `querés`→`quieres`, `podés`→`puedes`, etc.
- Adverbio regional: `acá`→`aquí`.

**Lookup exacto por palabra (no patrón):** "además/después/país/jamás/interés" NUNCA se tocan.

**Lo usa la compuerta como guardián:** si detecta voseo, emite bloqueante CRITICAL automático (rule dura del owner).

### 8. `findings.ts`

**Persistencia de hallazgos** (append-only JSONL):
- `recordHallazgo()` — persiste hallazgo completo con id único.
- `listHallazgos()` — devuelve últimas ocurrencias (si id aparece varias veces, gana la última).
- `updateHallazgoEstado()` — update append-only de estado (arreglado/confirmado/etc).

**Estructura:**
```typescript
Hallazgo {
  id: string;
  auditId: string;
  ts: string;
  codeVersion: string;
  subsistema: string;  // 'aprendizaje' (de format-audit)
  severidad: HallazgoSeveridad;
  estado: HallazgoEstado;  // 'abierto'|'confirmado'|'falso-positivo'|'arreglado'|'descartado'
  titulo: string;  // "[especialista] problema"
  descripcion: string;
  evidencia: string;
  fixPropuesto: string;
  confianza: number;
  verificacion?: { veredicto: string; razon: string };
  startSec?: number | null;  // Fase 2: segundo donde se ve el defecto
  endSec?: number | null;
  sceneIndex?: number | null;  // Fase 2: escena que lo cubre (resuelve compuerta)
}
```

### 9. `quality-gate.ts:decideGateVerdict + fail-closed`

**Fail-closed del juez AV** (línea 730):
```typescript
if (juez render-av falló && veredicto ≠ 'fail')
  → degradar a 'revisar' + bloqueante sintético
  → "El juez AV no pudo evaluar el render"
```

**Por qué:** Si el juez AV cae (cuota/timeout/parse error), el veredicto SIN él sería incompleto (nadie verificó lipsync/ritmo/audio). Fail-closed previene pasar un video a ciegas.

### 10. `repair-loop.ts:planRepairs(report)`

**Traducción determinista hallazgo→reparación.** Rutea por dimensión:
- **composicion/recorte/caption/anotacion/producto** → `surface-to-editor` (capa de edición, no auto).
- **animacion/movimiento** + sceneIndex → `reanimate` SOLO esa escena.
- **render-av (realismo/persona/cara)** + sceneIndex → `regenerate-image` SOLO esa escena.
- **voces/diarizacion/fidelidad** o audio/lipsync → `escalate` (sistémico).
- **Sin sceneIndex** → `surface-to-editor` o `escalate` (camino seguro).

No ejecuta nada: solo DECIDE. El executor (`repair-executor.ts`) lo hace con OK del owner.

---

## Wiring real (integración al pipeline)

**Entrada en pipeline.ts:**
```typescript
// Línea ~215-221: español neutro OBLIGATORIO antes del TTS
parsedScript = {
  ...parsedScript,
  segments: parsedScript.segments.map((s) => 
    ({ ...s, text: toNeutralSpanish(s.text) })
  ),
};
```

**Salida (post-render, post-editor):**
```typescript
// Línea ~540+: runQualityGate OBLIGATORIO
const gateReport = await runQualityGate({
  runId,
  originalVideoPath,  // si ripeo
  useGemini: true,  // activar juez AV
  // ... etc
});

// Veredicto determina finalStatus del run:
if (gateReport.veredicto === 'pass') finalStatus = 'completed';
else finalStatus = 'completed-with-warnings';
```

**Guardián test:** `quality-gate-wiring.test.ts` rompe si alguien revierte la compuerta a opt-in o desacopla el veredicto del estado del run.

---

## Estado del sistema

### ✅ Implementado (Fase 1 + Fase 2)

- [x] Panel de 6 especialistas CON VISIÓN de keyframes.
- [x] Juez Gemini video+audio (render-quality-judge), opt-in vía `useGemini:true` o env.
- [x] Rúbrica derivada del formato (deriveRubric).
- [x] Decisión determinista (decideGateVerdict, función pura).
- [x] Localización hallazgo→escena (scene-plan.json del run).
- [x] Persistencia hallazgos (findings.jsonl, subsistema 'aprendizaje').
- [x] Reflejo a KB como Eventos.
- [x] Guardián de español neutro (detectVoseo, bloquea voseo).
- [x] Fail-closed del juez AV.
- [x] Planificación de reparaciones (planRepairs, repair-loop.ts).
- [x] Test de cobertura (quality-gate.test.ts, sin IA ni ffmpeg).

### 🟡 Pendiente (Follow-up)

- [ ] **Ejecución de reparaciones dirigidas** (`repair-executor.ts`) — regenera SOLO la escena afectada, persiste corrección al run, OK del owner.
- [ ] **Feedback loop del aprendizaje** (Paso 8 del círculo) — usar correcciones aplicadas para NO repetir el error.
- [ ] **Detección de cara para anclaje de anotaciones** — las anotaciones deben anclar a zona exacta de rasgos (cara, papada, etc).
- [ ] **Surfaceado en UI** — las dimensiones activas de la rúbrica y hallazgos en el editor.

---

## Casos de uso

### Caso 1: Crear video nuevo (validación obligatoria)

```typescript
// 1. Render completado
// 2. runQualityGate automático (await, no fire-and-forget)
const gateReport = await runQualityGate({
  runId,
  useGemini: true,  // ← Gemini judge activado
});
// 3. Veredicto determina estado del run
if (gateReport.veredicto === 'pass') {
  finalStatus = 'completed';
} else {
  finalStatus = 'completed-with-warnings';  // fail-loud
  // El owner ve hallazgos en RunViewer, aplica reparaciones opcionales
}
```

### Caso 2: Ripear un formato (derivar rúbrica, comparar fidelidad)

```typescript
const analysis = analyzeAd(originalVideoPath);  // AdAnalysis
const plan = planTimelineFromFormat(analysis);
const motion = buildMotionMap({ videoPath: originalVideoPath });

const gateReport = await runQualityGate({
  renderVideoPath: '<RUNS_DIR>/<runId>/final.mp4',
  originalVideoPath,
  analysis,  // ← presente, sin rubric
  plan,
  motion,
  useGemini: true,
});

// deriveRubric corre automáticamente, emite criterios de:
// - nº voces distintas (plan.componentsToGenerate)
// - experto a cámara + lipsync (plan.segments[role])
// - mezcla animado/estático (motion.animatedPct, motion.cuts)
// - producto visible (analysis.product)
// - antes/después hinchada+progresión (analysis.editorialLine)
// - fidelidad global (siempre)
```

### Caso 3: Guardián de voseo

```typescript
const gateReport = await runQualityGate({
  contextText: "mirá el resultado, hacé click aquí",  // voseo detectado
  // ...
});

// Resultado:
// gateReport.veredicto === 'fail'
// gateReport.bloqueantes[0] === {
//   dimension: 'idioma-neutro',
//   severidad: 'critical',
//   estado: 'confirmado',
//   titulo: 'El guion/audio no está en español neutro (voseo: mirá, hacé)',
//   fixPropuesto: 'Reescribe esas formas a español neutro...'
// }
```

### Caso 4: Fail-closed del juez AV

```typescript
// Gemini quota agotada, renderQualityJudge lanza error
const gateReport = await runQualityGate({
  useGemini: true,
  // ...
});

// Resultado (línea 730-747):
// if (juez render-av falló && veredicto ≠ 'fail')
//   → veredicto = 'revisar' (degradado automáticamente)
//   → bloqueantes[0] = 'El juez AV no pudo evaluar el render'
// El owner ve el fallo explícito, NO pasa un video a ciegas
```

---

## Gotchas / Trampas

1. **Gemini judge = especialista EXTRA, NO paralelo**
   - Se inyecta vía `extraSpecialists` en el orquestador de format-audit.
   - Su verificador es PROPIO (passthrough, no refuta sin evidencia AV).
   - Los hallazgos AV (lipsync, ritmo, audio) pasan por él como hallazgos normales, NO como override.

2. **Rúbrica SIN IA: es contexto que SE SERIALIZA al prompt del panel**
   - `deriveRubric()` es determinista (función pura, hermana de `planTimelineFromFormat`).
   - Se antepone serializada al contextText de TODOS los especialistas (panel + juez AV).
   - NO es un motor paralelo: solo guía a los especialistas a buscar lo específico del formato.

3. **Anti-falsos-positivos: verificador CIEGO**
   - El verificador default (`defaultRunVerifier`, deep-audit.ts) es SOLO-TEXTO.
   - Un hallazgo AV legítimo (lipsync desfasado) sería marcado `incierto` por el verificador ciego.
   - POR ESO el juez AV trae `verify` propio: un passthrough que NO refuta sin evidencia AV.
   - Esto previene que un juez que VE+OYE sea vetado por uno que es ciego.

4. **Localización hallazgo→escena (Fase 2 "el brazo") es BEST-EFFORT**
   - Sin runId O sin scene-plan.json → sin escena.
   - Sin startSec del hallazgo → sin escena.
   - Conservador: si cae fuera de todo rango (salvo borde final ±0.5s) → retorna null, se mantiene sin escena.
   - El bloqueante se routing a `escalate` (seguro) en lugar de apuntar a escena equivocada.

5. **detectVoseo es LOOKUP EXACTO, no patrón**
   - "Además/después/país/jamás/interés" (acentuadas en neutro) NUNCA se tocan.
   - Imperativos voseo homógrafos del pretérito ("salí/sentí/descubrí") NUNCA se tocan (ambiguo sin contexto).
   - SOLO lista inequívoca con tilde → "mirá/hacé/tenés/querés".
   - Resultado: conservador (sin false positives), pero puede dejar algunos voseo sutiles.

6. **Clamp de tiempos en render-quality-judge es EXIGENTE**
   - Solo toca formas inequívocamente temporales (paréntesis, "segundo N", "t=Ns").
   - Un "200ms" NO se toca (no tiene "t=" ni está en segundo/s).
   - Anterior versión capturaba CUALQUIER "Ns" → "30s absorption" → "20.0s" (corrupción de evidencia).
   - Ahora: si Gemini alucina un tiempo fuera de rango, el clamp SOLO afecta esas formas canonicas.

7. **fail-closed es DEGRADACIÓN, no override**
   - Si ya hay un fail real (critical bloqueante), no lo pisamos.
   - Solo si veredicto es `pass` o `revisar` y el juez AV falló → degradamos a `revisar`.
   - Previene pasar un video a ciegas SIN elevar la alerta.

8. **Reparación dirigida (Fase 2) es DETERMINISTA por dimensión, NO IA**
   - `routeByDimension()` en repair-loop.ts traduce sin re-llamar IA.
   - Si el bloqueante es "recorte sucio" → `surface-to-editor` (no reparación automática).
   - Si es "lipsync desfasado" → `escalate` (audio/voz = sistémico).
   - Solo "realismo/persona/cara" + sceneIndex conocida → `regenerate-image` SOLO esa escena.

9. **Almacenamiento vía paths.ts, NUNCA process.cwd()**
   - Invariante: todo storage en `<RUNS_DIR>` (via paths.ts, que lee VF_STORAGE_DIR del .env).
   - Si alguien codea `.storage/findings.jsonl` de forma hardcoded → fail cuando el owner cambia VF_STORAGE_DIR.
   - La compuerta usa `KB_DIR` (findings.ts) que es `<STORAGE_DIR>/kb/`.

10. **El test `quality-gate.test.ts` rompe si se revierte la compuerta a opt-in**
    - Guardián explícito que verifica que decideGateVerdict corre SIEMPRE.
    - Si alguien intenta meter un `if (enableQualityGate)` → test falla.
    - Protege contra regresión silenciosa de la compuerta (invariante crítica del owner).

---

## Métricas de confianza y certeza

- **Especialista CON VISIÓN:** confianza = hallazgo con evidencia visual directa (≥0.7 típico).
- **Juez Gemini AV:** confianza = hallazgo con evidencia temporal (lipsync desfasado en segundo X).
- **Verificador adversarial:** 'confirmado' si no se pudo refutar; 'falso-positivo' si el verificador lo caza.
- **Verificador AV propio (juez):** 'incierto' (passthrough, no refuta) — hallazgos AV confían en su calidad, no en verificación ciega.

---

## Références en el código

| Componente | Archivo | Línea | Función |
|-----------|---------|-------|---------|
| Entrada orquestadora | quality-gate.ts | 601 | `runQualityGate()` |
| Derivación rúbrica | quality-gate.ts | 172 | `deriveRubric()` |
| Serialización rúbrica | quality-gate.ts | 359 | `serializeRubricForPrompt()` |
| Decisión determinista | quality-gate.ts | 522 | `decideGateVerdict()` |
| Guardián voseo | quality-gate.ts | 753 | `detectVoseo()` check |
| Fail-closed AV | quality-gate.ts | 730 | synthetic blocker |
| Localización hallazgo→escena | quality-gate.ts | 481 | `loadRunSceneTimings()` |
| Panel multi-agente | format-audit.ts | 267 | `runFormatAudit()` |
| Especialistas (6) | format-audit.ts | 52 | `FORMAT_SPECIALISTS` |
| Juez Gemini AV | render-quality-judge.ts | 166 | `renderQualityJudge()` |
| Anti-alucinación temporal | render-quality-judge.ts | 137 | `clampTimesInText()` |
| Sistema de prompts | render-quality-judge.ts | 33 | `JUDGE_SYSTEM_INSTRUCTION` |
| Transporte Gemini | gemini-video-transport.ts | 515 | `generateContentFromVideos()` |
| Persistencia | findings.ts | 54 | `recordHallazgo()` |
| Detección voseo | neutral-es.ts | 50 | `detectVoseo()` |
| Plaificación reparaciones | repair-loop.ts | 87 | `planRepairs()` |
| Schemas robustos | deep-audit.ts | 41 | `HallazgoDraftSchema` |
| Test guardián | quality-gate.test.ts | 1 | sin IA ni ffmpeg |

**⚠️ Gotchas (08-compuerta-jueces):**
- Gemini judge es especialista EXTRA inyectado vía extraSpecialists, NO motor paralelo ni override del panel de 6 especialistas. Su verificador propio (passthrough) previene que un juez que VE+OYE sea vetado por uno ciego.
- Rúbrica es CONTEXTO SERIALIZADO al prompt del panel, NO motor de juicio paralelo. deriveRubric() es determinista, hermana de planTimelineFromFormat, genera criterios específicos del formato que se anteponen a contextText de TODOS los especialistas.
- Localización hallazgo→escena (Fase 2 'el brazo') es BEST-EFFORT: sin runId, sin scene-plan.json, o sin startSec → sin escena. Conservador: si cae fuera de rango → null en lugar de escena equivocada. El bloqueante ruta a escalate (seguro).
- detectVoseo es LOOKUP EXACTO por palabra, NO patrón regex. Deja fuera a propósito: 'sos' (¿sigla SOS?), imperativos voseo sin tilde homógrafos del pretérito (salí/sentí/descubrí). Conservador: sin false positives pero puede dejar voseo sutil.
- Clamp de tiempos (render-quality-judge.ts:137) solo toca formas inequívocamente temporales: (Ns), t=Ns, 'segundo N', Ns suelto. Un '200ms' o '30s absorption' NO se toca. Anterior versión corrompía evidencia; esta preserva.
- fail-closed del juez AV es DEGRADACIÓN (pass/revisar → revisar), NO override. Si ya hay fail real (critical bloqueante), no lo pisamos. Previene pasar a ciegas sin elevar alerta.
- Almacenamiento vía paths.ts (VF_STORAGE_DIR), NUNCA process.cwd(). Si se codea hardcoded, falla cuando owner cambia ruta de storage. La compuerta usa KB_DIR (findings.ts).
- Reparación dirigida (repair-loop.ts) es DETERMINISTA por dimensión, sin re-llamar IA. routeByDimension() traduce bloqueante → (target, action) de forma segura: composicion/recorte/anotacion → surface-to-editor (no auto), lipsync/audio/voces → escalate, realismo+sceneIndex → regenerate-image SOLO esa escena.
- Test guardián (quality-gate.test.ts) rompe si alguien revierte la compuerta a opt-in. Protege contra regresión silenciosa de la invariante crítica del owner: validación OBLIGATORIA + fail-loud + test que impide desconectarla en silencio.
- Verificador adversarial es CIEGO (solo-texto). Un hallazgo AV legítimo (lipsync desfasado en segundo X) sería marcado 'incierto' por él. POR ESO el juez AV trae verify propio (passthrough): no refuta hallazgos AV sin evidencia AV.


---

# Subsistema 09-brazo-reparacion: Bucle de reparación dirigida

## Propósito

El **brazo de reparación** (Fase 2 del círculo de mejora) es el subsistema de **ejecución automática de correcciones dirigidas** sobre videos ya renderizados. Recibe hallazgos localizados del quality gate, propone reparaciones deterministas SIN IA, las muestra al owner con un botón "Auto-reparar", y **solo ejecuta con OK explícito**. Forkea el run original, regenera SOLO la escena que falla, y re-renderiza.

**Invariante de seguridad:** NADA se auto-aplica al SISTEMA (prompt/preset/config). Reparar un ARTEFACTO del run (output efímero) está permitido.

## Flujo end-to-end

### Paso 1: Quality Gate emite hallazgos localizados
- **Archivo:** `apps/web/lib/kb/quality-gate.ts:601` (`runQualityGate`)
- El pipeline llama `runQualityGate()` **SIEMPRE al terminar cada render** con `useGemini: true` (invariante "validación-obligatoria").
- El panel multi-agente (`runFormatAudit`) detecta defectos en keyframes + el juez Gemini video+audio (`render-quality-judge`) analiza video completo.
- Persiste hallazgos en KB con `recordHallazgo()` → `storage/kb/hallazgos/findings.jsonl`.
- **Localización** (Fase 2, paso 5b): si el run tiene `scene-plan.json`, cada hallazgo se mapea a una escena:
  - `loadRunSceneTimings()` lee escenas del run (línea 481)
  - `sceneAtSec()` busca la escena que cubre el timestamp `startSec` del hallazgo (línea 500)
  - Asigna `sceneIndex` al hallazgo si hay match (línea 709)
- Veredicto DETERMINISTA: `decideGateVerdict()` (línea 522) → 'pass', 'revisar', 'fail' según severidad + política
- Persiste el reporte en `storage/kb/hallazgos/quality-gates/gate:$runId.json` con `writeQualityGateReport()` (línea 306 en findings.ts)

### Paso 2: Endpoint GET muestra hallazgos + planes de reparación en UI
- **Archivo:** `apps/web/app/api/runs/[id]/gate/route.ts:26` (GET)
- Lee el reporte persistido: `readQualityGateReport('gate:' + runId)` (línea 41)
- Llama `planRepairs()` sobre los bloqueantes para traducirlos a RepairTarget (línea 48)
- Devuelve JSON: `{ qualityGate: QualityGateReport, repairs: RepairTarget[] }`

### Paso 3: UI renderiza hallazgos con botón "Auto-reparar"
- **Archivo:** `apps/web/app/(app)/runs/[id]/GateFindings.tsx:191`
- Componente cliente que fetch `GET /api/runs/$runId/gate` (línea 198)
- Mapea cada bloqueante a `FindingCard` con:
  - Severidad (chip rojo/naranja/amarillo)
  - Título limpio + fix propuesto
  - Etiqueta de acción (ej. "🔄 Regenerar imagen", "🎞️ Re-animar")
  - **Botón "Auto-reparar"** si la acción es ejecutable (línea 167)
- EXECUTABLE_ACTIONS = { 'regenerate-image', 'reanimate', 'regenerate-scene' } (línea 71)
- Las acciones 'surface-to-editor' (recorte/caption) y 'escalate' (sistémico) solo se muestran, no se ejecutan

### Paso 4: Owner clickea "Auto-reparar" → POST /api/runs/[id]/gate/repair
- **Archivo:** `apps/web/app/api/runs/[id]/gate/repair/route.ts:19` (POST)
- Lee `blockerIndex` del body (línea 36)
- **RE-DERIVA** la reparación desde el reporte persistido (línea 43): `planRepairs(gate)` nuevamente
  - No confía en el cliente; todo viene del reporte guardado
  - Accede al `repair = repairs[idx]` (línea 48)
- Llama `executeGateRepair({ originalRunId, repair })` (línea 53)
- Registra en system-log: `logSystemEvent({ kind: 'scene-regenerated' })` (línea 59)
- Devuelve `{ ok: true, newRunId }` → UI navega a `/runs/$newRunId` para seguir progreso

### Paso 5: Executor forcea el run y regenera SOLO la escena
- **Archivo:** `apps/web/lib/repair-executor.ts:49` (`executeGateRepair`)
- Valida que el run original exista y esté 'completed' o 'completed-with-warnings' (línea 59-65)
- Genera `newRunId` y fork: inserta nuevo run en DB con `originalRunId = runId` (línea 71)
- Traduce la reparación a un plan determinista: `buildRepairParse()` (línea 50)
  - **Archivo:** `apps/web/lib/repair-plan.ts:26`
  - Devuelve `CorrectionParse` con:
    - `sceneIndices: [sceneIndex]` — SOLO esa escena
    - `intent: 'regenerate'`
    - `newDirection: action.correctedImagePrompt || blocker.fixPropuesto` (0-150 chars)
    - `preserveComposition: true` — mantén encuadre/personajes, solo corrige el defecto
    - `reasoning: 'Reparación dirigida del gate'`
  - Devuelve `null` si la acción no es regenerable (editor/escalar)
- Dispara `applyCorrection()` en background: `{ parseOverride: parse }` (línea 86)
  - **Archivo:** `apps/web/lib/correction-pipeline.ts:227`
  - Con override DETERMINISTA, se SALTA el parseo NL con Gemini (línea 267-274)
  - El plan ya vino del gate, así que reutiliza el hallazgo localizado exactamente

### Paso 6: correction-pipeline regenera SOLO escenas afectadas
- Lee scene-plan.json del run original (línea 260)
- Identifica escenas afectadas (línea 277): `pickAffectedScenes()` filtra por `sceneIndices` (línea 184)
- Para cada escena afectada:
  - **No regenera nada**: si `uploadedAssetPath` viene (casos A/B: usuario subió imagen/video)
  - **Regenera con provider chain** (caso C, línea 419):
    - Prompt = `${scene.imagePrompt} CRITICAL CORRECTION: ${parsed.newDirection}`
    - Preserva la composición original (mismo encuadre, personajes)
    - Pool 3 paralelo: Higgsfield → OpenAI → Vertex → Google (línea 562)
    - Validator V3 en loop (máx 2 intentos): si falla, retry con hint (línea 494-539)
- **Re-animación con Kling** (línea 577-635):
  - Si el preset original era animated (ej. 'ugc-broll', 'voiceover-animated')
  - Y la escena perdió videoPath (regeneración la marcó sin video)
  - Kling genera video de la imagen: `kling.generate({ prompt: motionPrompt, imageBase64, model: 'kling-v2-6' })`
  - Pool 5 paralelo (Kling aguanta más carga)
  - Si falla, mantiene la imagen estática (fallback graceful)
- **NO re-valida**: el usuario tomó la decisión editorial, la compuerta NO la pisa (línea 14-15)
- Re-renderiza: `compositorRemotion.run()` con Remotion (línea 744)
  - Renderiza todo (audio + escenas nuevas + viejas + subtítulos) a final.mp4
  - El owner verifica abriendo el run nuevo y re-corriendo el gate si quiere

## Tipos y contratos

### RepairAction (quality-gate.ts:810)
```typescript
type RepairAction =
  | { kind: 'regenerate-image'; sceneIndex: number; correctedImagePrompt: string }
  | { kind: 'reanimate'; sceneIndex: number; correctedMotionPrompt: string }
  | { kind: 'extend-duration' | 'trim-duration'; sceneIndex: number; newEndSec: number }
  | { kind: 'regenerate-scene'; sceneIndex: number }
  | { kind: 'surface-to-editor' }      // recorte/caption/anotación
  | { kind: 'escalate' };               // sistémico/revisión
```

### RepairTarget (quality-gate.ts:818)
```typescript
interface RepairTarget {
  blocker: GateBlocker;                 // hallazgo original localizado
  target: 'image' | 'motion' | 'timing' | 'composite' | 'systemic';
  sceneIndex: number | null;            // escena del scene-plan.json (resuelto por gate)
  action: RepairAction;                 // qué hacer
}
```

### GateBlocker (findings.ts:260)
Espejo legible del Hallazgo para el UI:
```typescript
interface GateBlocker {
  dimension: string;                    // especialista: 'composicion-recorte', 'voces-diarizacion', etc.
  severidad: HallazgoSeveridad;         // 'low' | 'medium' | 'high' | 'critical'
  estado: HallazgoEstado;               // 'abierto' | 'confirmado' | …
  titulo: string;                       // sin prefijo '[especialista]'
  fixPropuesto: string;                 // accionable: "...en 150 chars"
  confianza: number;                    // 0-1
  sceneIndex?: number | null;           // Fase 2: escena del hallazgo (por localización)
  startSec?: number | null;             // tiempo inicio del defecto
  endSec?: number | null;               // tiempo fin del defecto
}
```

### CorrectionParse (correction-pipeline.ts:88)
Plan DETERMINISTA de corrección (generado por `buildRepairParse()` o por Gemini):
```typescript
interface CorrectionParse {
  startSec: number;                     // rango temporal (informativo si sceneIndices viene)
  endSec: number;
  sceneIndices: number[] | null;        // SOLO estas escenas se regeneran
  intent: 'regenerate' | 'replace';
  newDirection: string;                 // lo que SÍ se quiere ver (0-150 chars)
  preserveComposition: boolean;         // TRUE: corrige defecto puntual. FALSE: cambio radical.
  reasoning: string;                    // por qué así
}
```

## Routing por dimensión (repair-loop.ts:27)

La función `routeByDimension(dimension, sceneIndex, fix)` **mapea hallazgo → (target, acción)** de forma DETERMINISTA:

| Dimensión | Tiene sceneIndex | → Acción | Target |
|-----------|------------------|---------|--------|
| composicion, recorte, caption, anotacion, producto | — | surface-to-editor | composite |
| animacion, movimiento | Sí | reanimate escena | motion |
| animacion, movimiento | No | surface-to-editor | motion |
| voces, diarizacion, fidelidad | — | escalate | systemic |
| render-av (realismo/cara/persona) | Sí + NO es audio/lipsync | regenerate-image escena | image |
| resto (audio/lipsync/ritmo) | — | escalate | systemic |

**Lógica pura:** no regenera un audio regenerando una imagen; no regenera edición como si fuera visual.

## Archivos y funciones clave

| Archivo | Línea | Función | Rol |
|---------|-------|---------|-----|
| quality-gate.ts | 601 | `runQualityGate(input)` | Orquestador: corre panel → deriva veredicto → localiza hallazgos → persiste |
| quality-gate.ts | 522 | `decideGateVerdict(result, policy)` | FUNCIÓN PURA: bloqueantes + veredicto (pass/revisar/fail) |
| quality-gate.ts | 172 | `deriveRubric(analysis, plan, motion?)` | FUNCIÓN PURA: criterios específicos del formato desde análisis |
| quality-gate.ts | 810-834 | `RepairAction` / `RepairTarget` / `RepairLoop` | Tipos del contrato Fase 2 |
| repair-loop.ts | 27 | `routeByDimension(dimension, sceneIndex, fix)` | FUNCIÓN PURA: hallazgo → (target, acción) determinista |
| repair-loop.ts | 87 | `planRepairs(report)` | Traduce bloqueantes de reporte a RepairTarget[] (implementa RepairLoop) |
| repair-plan.ts | 26 | `buildRepairParse(repair)` | FUNCIÓN PURA: RepairTarget → CorrectionParse determinista. Devuelve null si no ejecutable. |
| repair-executor.ts | 49 | `executeGateRepair(input)` | Fork run + applyCorrection con parseOverride determinista |
| api/runs/[id]/gate/route.ts | 26 | GET /api/runs/[id]/gate | Lee reporte + planRepairs → JSON UI |
| api/runs/[id]/gate/repair/route.ts | 19 | POST /api/runs/[id]/gate/repair | RE-deriva desde reporte persistido → executeGateRepair |
| GateFindings.tsx | 191 | export `GateFindings({ runId })` | Componente cliente: fetch + muestra hallazgos + botón "Auto-reparar" |
| GateFindings.tsx | 103 | `FindingCard({ f, action, … })` | Tarjeta: severidad + título + fix + botón (si ejecutable) |
| correction-pipeline.ts | 227 | `applyCorrection(opts)` | Fork + regenera escenas afectadas + re-anima con Kling + re-renderiza |
| findings.ts | 306 | `writeQualityGateReport()` | Persiste reporte en storage/kb/hallazgos/quality-gates/ |
| findings.ts | 318 | `readQualityGateReport(scope?)` | Lee reporte (scope='gate:' + runId) |
| pipeline.ts | 2217 | runQualityGate call | Llama la compuerta SIEMPRE con useGemini:true, estado final depende del veredicto |

## Persistencia y flujo de datos

```
┌─────────────────────────────────────────────────────────────────┐
│ PIPELINE (pipeline.ts:2216)                                     │
│ runQualityGate({runId, useGemini:true, contextText})            │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ↓
┌─────────────────────────────────────────────────────────────────┐
│ QUALITY GATE (quality-gate.ts:601)                              │
│ 1. runFormatAudit → hallazgos + panel + juez Gemini AV         │
│ 2. loadRunSceneTimings → mapea hallazgo startSec → sceneIndex   │
│ 3. decideGateVerdict(hallazgos) → pass/revisar/fail             │
│ 4. writeQualityGateReport → storage/kb/hallazgos/quality-gates/ │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ↓
    storage/kb/hallazgos/quality-gates/gate:${runId}.json
    {
      gateId, scope, veredicto, bloqueantes[], recomendaciones[]
    }
                   │
      ┌────────────┴────────────┐
      │                         │
      ↓                         ↓
┌──────────────┐         ┌───────────────┐
│ GET /api/.. │         │ Owner clicks  │
│ /gate       │         │ "Auto-reparar"│
└──────┬───────┘         └───────┬───────┘
       │                         │
       ├─ readQualityGateReport  │
       │  scope = 'gate:' + id   │
       │                         │
       ├─ planRepairs(report)    │
       │  repair-loop.ts:87      │
       │                         │
       ├─ return repairs[]       │
       │                         │
       └─> UI (GateFindings)     │
           muestra bloqueantes   │
           + botón               │
                                 │
       ┌─────────────────────────┘
       │
       ↓
   POST /api/runs/[id]/gate/repair
   { blockerIndex: N }
       │
       ├─ readQualityGateReport (revalidar)
       ├─ planRepairs(gate)
       ├─ repair = repairs[idx]
       │
       ↓
   executeGateRepair({originalRunId, repair})
       │
       ├─ buildRepairParse(repair)
       │  repair-plan.ts:26
       │  → CorrectionParse { sceneIndices: [sceneIndex], … }
       │
       ├─ fork run (newRunId)
       ├─ applyCorrection({parseOverride: parse})
       │  correction-pipeline.ts:227
       │  │
       │  ├─ pickAffectedScenes (prioriza sceneIndices)
       │  ├─ pool 3: provider chain (Higgsfield/OpenAI/Vertex)
       │  ├─ validator V3 (máx 2 intentos)
       │  ├─ pool 5: Kling re-animation (si animated preset)
       │  ├─ compositorRemotion.run()
       │  │
       │  └─> newWorkDir/final.mp4
       │
       └─> return { ok: true, newRunId }

   UI navega a /runs/$newRunId
   Owner verifica + puede re-correr gate si quiere
```

## Invariantes y gotchas

### 1. NADA se auto-aplica al SISTEMA
- Solo PROPONE cambios (UI con botón)
- Reparar ARTEFACTO del run (output efímero) ✓
- Cambiar prompt/preset/config del sistema ✗ (nunca sin owner)
- Fuente: quality-gate.ts:808-809, repair-executor.ts:1-6

### 2. La COMPUERTA corre SIEMPRE (invariante "validación-obligatoria")
- Cada render termina → `runQualityGate()` con `useGemini: true`
- Estado final del run depende de veredicto:
  - 'pass' + sin editor warnings → 'completed'
  - Otra cosa (fail/revisar/no-verificado) → 'completed-with-warnings'
- Pipeline NUNCA marca 'completed' a ciegas (pipeline.ts:2250)
- Fuente: pipeline.ts:2203-2265, quality-gate.ts:1-22

### 3. Localización hallazgo → escena (Fase 2)
- El quality gate MAPEA timestamp → escena (`sceneAtSec()`)
- Sin scene-plan.json o sin startSec → sceneIndex = null
- Si sceneIndex = null → no hay escena concreta → 'surface-to-editor' o 'escalate'
- Fuente: quality-gate.ts:480-507, 699-714

### 4. Routing DETERMINISTA (repair-loop.ts)
- NO llama IA, NO re-pregunta al modelo
- Basado SOLO en dimensión del hallazgo + presencia de sceneIndex
- Edición (recorte/caption) SIEMPRE → surface-to-editor (no auto)
- Sistémico (voces multi, diarizacion) SIEMPRE → escalate (no auto)
- Audio/lipsync/ritmo (incluso con escena) → escalate (no auto)
- Fuente: repair-loop.ts:27-84

### 5. CorrectionParse: override DETERMINISTA (correction-pipeline.ts)
- Con `parseOverride`, se SALTA `parseCorrectionMessage()` (Gemini NL)
- Plan viene ya localizado desde repair-plan.ts → no hay re-derivación
- `sceneIndices: [sceneIndex]` PRIORIZA sobre tiempo (pickAffectedScenes línea 182)
- `preserveComposition: true` = defecto puntual (mantén encuadre/personajes)
- Fuente: correction-pipeline.ts:267-274, 180-190

### 6. NO re-valida tras reparar
- El usuario tomó decisión editorial → compuerta NO la cuestiona
- Owner verifica abriendo run nuevo (puede re-correr gate manualmente)
- correction-pipeline línea 14-15 documenta esto explícitamente
- Fuente: correction-pipeline.ts:14-15

### 7. Re-animación con Kling (NO Higgsfield DoP)
- Solo si preset era animated (ej. 'ugc-broll', 'voiceover-animated')
- NO regenera DoP (motion de la imagen) — regenera VIDEO entero
- Prompt de movimiento: `${imagePrompt} + "Motion: subtle natural movement…"`
- Fallback graceful: si Kling falla, mantiene imagen estática
- Fuente: correction-pipeline.ts:577-635, 581-589

### 8. Verificación del Gemini judge en quality gate
- Si `useGemini: true` y el juez AV falla (cuota/timeout) → FIX 3 (fail-closed)
- Añade bloqueante sintético: "El juez AV no pudo evaluar"
- Veredicto → 'revisar' (mínimo, no 'pass')
- No se confía en silencio; se marca como "NO VERIFICADO"
- Fuente: quality-gate.ts:723-747

### 9. Política determinista de veredicto
- `failOn` (default 'critical'): severidad mínima que vuelca a 'fail'
- `reviewOn` (default 'high'): severidad mínima → 'revisar'
- `reviewOnMediumCount` (default 3): N de 'medium' que disparan 'revisar'
- `countUnverified` (default true): los 'abierto' cuentan igual que 'confirmado'
- Configurable vía `VF_GATE_*` vars de entorno (next.config.mjs carga .env raíz)
- Fuente: quality-gate.ts:52-98, 522-572

### 10. Español neutro: guardián de VOSEO
- `detectVoseo()` caza formas voseo en contextText
- Si se detectan → bloqueante 'critical' + veredicto 'fail'
- Regla dura del owner: JAMÁS se publica con voseo
- Normalización previa en pipeline (neutral-es.ts) es defensa 1ra capa
- Guardián de compuerta es red anti-regresión
- Fuente: quality-gate.ts:749-768, pipeline.ts:2224

## Pasos pendientes (Paso 8: Aprender)

El círculo tiene 8 pasos:
1. LEER (Gemini ve+oye) ✓
2. ENTENDER (panel multi-agente) ✓
3. DETECTAR (hallazgos verificados) ✓
4. PROPONER (fixPropuesto en KB) ✓
5. MOSTRAR (GateFindings.tsx) ✓
6. APLICAR (executeGateRepair) ✓
7. REGENERAR (applyCorrection + Kling) ✓
8. APRENDER (pendiente): el sistema debe cerrar el loop — no repetir el mismo hallazgo en futuros videos

**Cómo cerrar paso 8:** Grabar qué hallazgos se repararon + cómo (qué prompt/acción) + resultado (pasó re-gate o falló). Feedback loop → sesgar prompts/criterios de formato hacia lo que FUNCIONÓ.

**⚠️ Gotchas (09-brazo-reparacion (Repair Loop Subsystem)):**
- La compuerta SIEMPRE corre (invariante 'validación-obligatoria'), NUNCA está opt-in ni fire-and-forget. El estado final 'completed' vs 'completed-with-warnings' DEPENDE del veredicto. Si falla sin reporte (no-verificado) → ya es fail-loud, el errorMessage dice por qué. Pipeline #2203-#2265.
- Localización hallazgo→escena solo funciona si run tiene scene-plan.json Y hallazgo trae startSec. Sin eso, sceneIndex=null → reparación cae a 'surface-to-editor' o 'escalate'. La localización es best-effort (línea 703-714 quality-gate.ts).
- routeByDimension es DETERMINISTA, nunca llama IA. Edición (recorte/caption/anotacion/producto) SIEMPRE→surface-to-editor (capa manual, no auto). Sistémico (voces/diarizacion) SIEMPRE→escalate. Audio/lipsync/ritmo NUNCA se regeneran como imagen (repair-loop.ts:74-83).
- CorrectionParse con sceneIndices PRIORIZA sobre startSec/endSec de tiempo. pickAffectedScenes filtra por índice primero (línea 182 correction-pipeline.ts). Si viene sceneIndices, el rango temporal se ignora.
- preserveComposition=true (default para reparación dirigida) = defecto puntual. Mantén el encuadre/personajes/ambiente original, solo corrige el problema. El prompt va como 'CRITICAL CORRECTION' sobre el imagePrompt original (línea 428 correction-pipeline.ts).
- NO se re-valida TRAS reparar. El usuario decidió editorial → compuerta NO la cuestiona (correction-pipeline.ts línea 14-15). Owner debe verificar abriendo run nuevo y corriendo gate manualmente si quiere chequear.
- Re-animación con Kling (NO DoP de Higgsfield) = regenera VIDEO ENTERO, no solo motion. Solo aplica si preset era animated ('ugc-broll', 'voiceover-animated', etc). Si falla Kling, fallback graceful: mantén imagen estática (línea 625-629 correction-pipeline.ts).
- Verificador de Gemini judge en quality gate: si useGemini:true y el juez AV falla (cuota/timeout/error) → FIX 3 (fail-closed, línea 723-747). Añade bloqueante sintético + veredicto→'revisar', NUNCA deja pasar como 'pass'. No confía en silencio.
- RE-DERIVACIÓN del lado servidor en repair endpoint: no confía en datos del cliente. Lee reporte persistido, vuelve a llamar planRepairs(), extrae repair[blockerIndex], luego ejecuta. Así aunque el cliente envíe un payload truncado, la reparación viene de KB de verdad (repair route línea 43-51).
- VF_GATE_* vars de env configuran política (failOn, reviewOn, countUnverified). Cargadas por next.config.mjs en process.env al arrancar. Si no se pasan, DEFAULT_GATE_POLICY. Modificarlas requiere restart del servidor (quality-gate.ts línea 79-98).
- Español neutro: guardián de voseo en compuerta. Si se detectan formas voseo (sos/tenés/podés/hacé/mirá) en contextText → bloqueante 'critical' + veredicto 'fail'. Regla dura del owner (quality-gate.ts línea 753-768, 6c FIX).
- buildRepairParse devuelve null si la acción no es ejecutable (editor/escalar/sin escena). El executor lo maneja (repair-executor.ts línea 50-56) y responde 409 Conflict (action not executable). Solo 'regenerate-image', 'reanimate', 'regenerate-scene' son ejecutables (repair-plan.ts línea 13-19).
- Con parseOverride determinista, se SALTA parseCorrectionMessage() completo (Gemini NL). El plan ya vino del repair-plan.ts con sceneIndices listo. Gemini no re-pregunta nada (correction-pipeline.ts línea 268-274). Evita re-derivación y speeds up execution.
- Pool concurrency: image regeneration = 3 workers paralelo (Higgsfield ~5 qps, Vertex 1 RPM), Kling re-animation = 5 workers paralelo (Kling resource pack). Intentos: 2 máximo por escena antes de fallar (correction-pipeline.ts línea 445, 560-562).
- FIX 2 (lipsync): no regeneres una cara que habla sin voz nativa del mismo modelo (Veo 3.1). Si TTS aparte (ElevenLabs) + video mudo → lipsync inexistente, compuerta lo caza. La voz debe ser NATIVA, extraída del clip (scripts/prep-key.ts, invariante CLAUDE.md).
- Paso 8 (Aprender) pendiente: el sistema propone+ejecuta pero NO cierra loop aprendizaje. Grabar qué halló+cómo se reparó+resultado → feedback hacia pasos 1-4 (panel/criterios de formato). Hoy es lineal (render→gate→repairs); falta loop (repairs→aprende→preset mejor).


---

# 10-kb-cerebro-consejo: Base de Conocimiento + Cerebro Evolutivo

## Propósito y Arquitectura

Video Factory tiene un **subsistema de conocimiento distribuido** en 3 fases + un cerebro evolutivo que la IA y los desarrolladores usan para mantener la coherencia y mejorar continuamente sin cambios automáticos:

1. **Fase 0 (RECOLECCIÓN)**: `record.ts` — auto-log append-only de eventos del sistema (runs, decisiones, feedback, hallazgos). Cero IA, barato, NUNCA rompe el flujo.
2. **Fase 1 (CONSULTA)**: `query.ts` — filtrado/ubicación de eventos; pre-digerido en contexto CHICO para agentes (NO dumps crudos).
3. **Fase 2 (AUDITORÍA PROFUNDA)**: `deep-audit.ts` — pipeline estructurado: especialistas (1 por subsistema) → verificación adversarial → síntesis con Claude. ON-DEMAND, cacheado por codeVersion.
4. **Invariantes VIVOS**: `invariants.ts` — registro (JSONL append-only) de reglas duras + wirings no-obvios; inyectadas en system-context de toda IA in-app; sincronizadas a CLAUDE.md para Claudes desarrolladores.
5. **Compuerta de Calidad**: `quality-gate.ts` — veredicto DETERMINISTA (sin IA) sobre renders: pass/revisar/fail → hallazgos → reparación dirigida (Fase 2, implementation en `repair-loop.ts` + `repair-executor.ts`).
6. **Cerebro Evolutivo**: `prompt-evolution.ts` — detecta patrones sistémicos de errores, propone patches al SYSTEM_PROMPT, owner aprueba SIN auto-aplicar (invariante "nada se auto-aplica").

**Wiring crítico**: `system-log.ts` (M9 Pieza 2) es el **bridge M9** que auto-logea eventos y los refleja a la KB vía `systemEventToKb`. `system-context.ts` (M9 Pieza 1) inyecta todo el contexto + invariantes en cada llamada a Claude.

## Archivos Clave

### Almacenamiento y Persistencia

- **`record.ts`** (línea:12 KB_DIR) — Define `storage/kb/` como raíz de la KB. Tipos: `KbEvento` (formato unitario), `KbSubsistema`, `KbTipo`. Cada evento se append-only a `eventos/{subsistema}.jsonl`. También mantiene un índice `indice/por-entidad.json` para ubicación rápida sin leer todo. `getCodeVersion()` cachea el git short hash.
  
- **`findings.ts`** (línea:13) — Persiste **hallazgos** (resultado de auditoría profunda) en `hallazgos/findings.jsonl` (append-only, última ocurrencia por `id` gana). Define `Hallazgo` (id, auditId, severidad, estado, titulo, descripción, evidencia, fixPropuesto, confianza, **Fase 2: startSec/endSec/sceneIndex** para reparación dirigida). También maneja:
  - `last-audit.json` — caché de último audit por subsistema (codeVersion+ts) para ahorro.
  - `last-report.json` — resumen ejecutivo del último audit (mostrado en /admin "Consejo").
  - `format-reports/*.json` — reportes scoped por runId/presetId/etiqueta (NO pisan global).
  - `quality-gates/*.json` — veredictos de la compuerta (pass/revisar/fail con bloqueantes + recomendaciones).

### Invariantes (Memoria Viva del Proyecto)

- **`invariants.ts`** (línea:20 INVARIANTS_PATH = `storage/kb/invariantes.jsonl`) — Registro de invariantes (reglas duras + wirings no-obvios). Tipos: `Invariant` (id, ts, categoria, titulo, regla, porQue, fuente). `CORE_INVARIANTS` seed (42 invariantes iniciales, línea:42) cubre:
  - **Idioma** (español neutro, PROHIBIDO voseo): 'idioma-neutro' (línea:44-52) — lista de voseo compartida en `apps/web/lib/neutral-es.ts`, guardiana en `quality-gate.ts` con bloqueo critical.
  - **Seguridad**: 'nada-auto-aplica' (línea:55-62) — invariante radical del owner: sistema PROPONE, owner aprueba. Wiring: `prompt-evolution.ts applyPatch` gated (línea:581).
  - **Wiring**: 'kb-fed-by-system-log' (línea:64-72) — **bridge M9 crítico**: events → systemEventToKb (NO emisores paralelos que dupliquen). 'storage-unificado' (línea:74-81): VF_STORAGE_DIR forza `/storage`.
  - **Arquitectura**: '.env raíz es fuente única' (línea:84-90), 'validación SIEMPRE' (línea:234-243).
  - **Producto** (14 invariantes de dominio): personas UGC con soul_2, lipsync nativo (Veo 3.1), PiP con movimiento (clip, no foto fija), anotaciones ancladas+sincronizadas, chroma+despill por píxel, "Estilo CapCut" (edición profunda), antes/después progresivo, validators detectan defectos, círculo de mejora.
  
  **Inyección**: `formatInvariantsForContext()` (línea:349) produce texto ≤1800 chars para system prompts (línea:413 en system-context.ts); `renderInvariantsMarkdown()` (línea:364) sincroniza a CLAUDE.md via `scripts/sync-invariants.ts`.

### Auditoría Profunda (Deep Audit)

- **`deep-audit.ts`** (línea:1-415) — Pipeline estructurado sin IA auto-ejecutable. `deepAudit(opts)` (línea:227):
  1. **Resolve subsistemas** (línea:237-240): manual (opts.subsistemas) o auto (del stats de KB).
  2. **Caché por codeVersion** (línea:260-276): si codeVersion no cambió Y sin eventos nuevos desde último audit, SALTA subsistema (ahorro §8 CONOCIMIENTO.md).
  3. **Especialistas** (línea:284-294): 1 por subsistema, mandato ADVERSARIAL (busca problemas). Reciben `buildContextFor(subsistema, ~3500 chars)` (línea:286 query.ts:buildContextFor). Modelos: Haiku 'rapido' (default), Sonnet 'profundo'.
  4. **Verificación adversarial** (línea:296-336): especialistas high/critical → verificador intenta REFUTAR (falso-positivo killer). Cap: `maxVerificaciones` default 8. Persiste hallazgos en `findings.jsonl`.
  5. **Síntesis IA superior** (línea:368-376): dedup + ranking + próximo paso accionable. NO inventa hallazgos nuevos.
  6. **Persistencia** (línea:380-400): actualiza `last-audit.json` (subsistemas auditados + ts), escribe `last-report.json` (resumen para /admin).
  
  **Schemas robustos** (línea:32-77): truncan en vez de rechazar (evita perder output por longitud — bug histórico). `HallazgoDraft`, `SpecialistOutput`, `Verificacion`, `Sintesis` con `.catch()` defensivos en severidades/números.
  
  **Inyección de dependencias** (línea:106-119): `DeepAuditDeps` permite testing SIN gastar IA/API.

### Compuerta de Calidad (Quality Gate)

- **`quality-gate.ts`** (línea:1-200+) — Veredicto DETERMINISTA sobre renders (sin IA de juicio). `runQualityGate(runId, opts)` (línea:200+):
  1. Localiza render en `storage/runs/{runId}`.
  2. (Opcional) Deriva rúbrica desde formato aprendido (`deriveRubric` línea:200+, hermano de `planTimelineFromFormat`).
  3. Corre `runFormatAudit` (panel multi-agente con Gemini ve+oye).
  4. `decideGateVerdict` (función PURA, línea:200+): aplica `GatePolicy` (fail_on='critical', review_on='high', etc.) a hallazgos → veredicto.
  5. Persiste `QualityGateReport` (línea:286-302): gateId, scope, veredicto, bloqueantes, recomendaciones, auditId ref, policy usada, errores.
  6. **Invariante guardián**: test `quality-gate-wiring.test.ts` (línea:242 invariants.ts) ROMPE si alguien desacopla la compuerta del estado final del run.
  
  **Policy DETERMINISTA** (línea:52-98): fail_on/review_on/reviewOnMediumCount/countUnverified. Overrideable por env VF_GATE_* (línea:79-94).

### Sistema de Logs + Context Inyectado

- **`system-log.ts`** (línea:1-210) — M9 Pieza 2: auto-log append-only de eventos (runs, presets, editor-ia acciones, etc.) a `storage/system-log.jsonl`. `logSystemEvent(event)` (línea:129) NUNCA throw. `SystemEventKind`: run-started/completed/failed, preset-created/approved, editor-ia-action/verdict, suggestion-posted, scene-regenerated, auto-learn-invoked, chat-discuss-message, video-understood, config-changed, other (línea:32-46). **Bridge crítico** (línea:61-121): `systemEventToKb(event)` mapea evento a `Evento` KB y lo routea a `recordEvent` (Fase 0) — EVITA duplicados con emisores paralelos (invariante 'kb-fed-by-system-log').
  
- **`system-context.ts`** (línea:1-420) — M9 Pieza 1: snapshots completo del proyecto para inyectar en CADA llamada Claude. `buildSystemContext()` (línea:303) arma: projectName/description, modes, iaLayers (M1-M9), brands (con product count + logo), presets (active/pending), providers (detecta de env: OpenAI, Google, GCP, Higgsfield, Kling, FAL, ElevenLabs), recentEventsFormatted (últimos 12 eventos → 2000 chars), presetConfidenceFormatted (M7 #3 feedback loop de juicios pasados). `formatSystemContextForPrompt(ctx)` (línea:333) convierte a markdown legible (≤2500 chars). `getSystemContextForPrompt()` (línea:404) agrega invariantes (línea:410-413: import dinámico de `formatInvariantsForContext`).

### Cerebro Evolutivo (Prompt Evolution)

- **`prompt-evolution.ts`** (línea:1-682) — Ciclo de evolución automática de prompts (SIN auto-aplicar). Pasos:
  1. **detectSystemicPatterns()** (línea:328): escanea últimos 30 días de `system-log.jsonl` + `post-render-reports.json` (última 50 runs), agrupa por categoría (burned-in-text, duration-mismatch, animation-failure, brand-incoherence, etc.), filtra por minOccurrences (default 3 runs distintos) → `SystemicPattern[]` (línea:41-80).
  2. **proposePromptPatch()** (línea:513): recibe patrón + prompt actual → Claude Sonnet sugiere patch (patchType=addition/modification/reinforcement, oldText/newText, reasoning, expectedImprovement, confidence 0-100). Persiste en `storage/prompt-patches/proposals.jsonl` con status='pending'.
  3. **applyPatch()** (línea:581): GATED por owner. Lee patch, encuentra template literal de SYSTEM_PROMPT por varName (regex defensivo línea:606), aplica modificación DENTRO de backticks, valida sin backticks en oldText/newText (línea:640-645), escribe al archivo, actualiza status → 'applied'. NUNCA auto-commit.
  4. **rejectPatch()** (línea:670): status → 'rejected'.
  
  **Schemas** (línea:41-117): `SystemicPatternSchema`, `PromptPatchProposalSchema` con validaciones estrictas (confidence 0-100, newText min 10 chars, oldText nullable solo si addition).
  
  **Safety** (línea:175-201): lista `FORBIDDEN_PATHS` (Null; prompt-evolution no edita archivos, solo propone). Sequencing via promise chain (línea:180-200) para evitar race conditions en read-modify-write.

### Auto-Audit (Disparador Automático)

- **`auto-audit.ts`** (línea:1-150) — Dispara `deepAudit()` fire-and-forget al terminar cada run, pero SOLO cada N runs o X horas (agrupado + cacheado). Controlado por:
  - **Botón en /admin**: persiste en `auto-audit-config.json` (enabled flag).
  - **Env**: VF_AUTO_AUDIT=1 (override headless), VF_AUTO_AUDIT_EVERY=5 (default), VF_AUTO_AUDIT_MAX_HOURS=24 (default).
  - Status: 'boton' (config file) > 'env' > 'off'.
  
  `maybeAutoAudit()` (línea:113): cuenta runs, si alcanza umbral → reset cursor → llama `deepAudit({ depth: 'rapido' })` (Haiku barato, auto-scoped, cacheado). Best-effort.

### Queries y Ubicación

- **`query.ts`** (línea:1-100+) — Fase 1: consulta eventos sin IA. `query(filters)` (línea:81): filtra por vault, subsistema, tipo, entidad (AND), tag, estado, rango de ts, limit. Ordena descendente por ts (ISO 8601 lex). `buildContextFor(subsistema, maxChars)` (línea:200+): lee subsistema, sintetiza contexto PRE-DIGERIDO (últimos N eventos) máximo maxChars para el especialista en `deep-audit.ts:286` (default ~3500).
  
- **`record.ts`** (línea:1-137) — Fase 0: recolección. `recordEvent(input)` (línea:79): append evento a `eventos/{subsistema}.jsonl`, actualiza índice `indice/por-entidad.json`. `getCodeVersion()` cachea git short hash (línea:74). Cero IA, NUNCA throw (best-effort).

## Flujos End-to-End

### Flujo 1: Auto-Log del Pipeline (M9 Bridge)

```
(Pipeline finaliza run)
  ↓
logSystemEvent({ kind:'run-completed', data: {runId, ... } })
  ↓
systemEventToKb() — mapea a RecordInput
  ↓
recordEvent() — append a KB eventos/pipeline.jsonl + índice
  ↓
(Siguiente deepAudit ve el evento en queries)
```

**Garantía**: Sin emisores paralelos (invariante 'kb-fed-by-system-log'). Si un nuevo stage emite eventos, DEBE pasar por `logSystemEvent` en `system-log.ts`, NO crear un `recordEvent` paralelo.

### Flujo 2: Auditoría Profunda On-Demand

```
/admin "Auditar ahora" (btn) → POST /api/admin/kb/audit
  ↓
deepAudit({ subsistemas?: [...], depth: 'rapido'|'profundo', force?: bool })
  ↓
  1. Resuelve subsistemas (manual o auto desde KB stats)
  2. Caché: si codeVersion no cambió + sin eventos nuevos → SALTA
  3. Especialistas (1 por subsistema)
       - Reciben brief adversarial + contexto pre-digerido
       - Corren con Haiku/Sonnet según depth
       - Devuelven hallazgos [titulo, severidad, descripción, evidencia, fixPropuesto, confianza]
  4. Verificación adversarial (high/critical → verificador refuta falsos positivos)
  5. Persistencia: recordHallazgo() → findings.jsonl + reflejo a KB como evento
  6. Síntesis: IA superior dedup + ranking + próximo paso
  7. writeLastAuditReport() → last-report.json (mostrado en /admin)
  8. writeLastAudit() → caché para siguiente audit
  ↓
Resultado: AuditReport (auditId, hallazgos[], sintesis, errores, llamadas)
```

**Costo**: Haiku ~2-4 min (especialistas) + verificadores; Sonnet ~5-10 min. Cacheado: segundo audit del MISMO codeVersion es casi instant.

### Flujo 3: Detección de Patrones + Patch Evolutivo

```
(Runs terminan con errores recurrentes)
  ↓
/admin "Detectar patrones" btn → detectSystemicPatterns({ minOccurrences: 3 })
  ↓
Lee system-log.jsonl (últimos 30 días) + post-render-reports.json (últimas 50 runs)
  ↓
Agrupa por categoría (burned-in-text, duration-mismatch, etc.)
  ↓
Filtra: solo patrones con ≥3 runs distintos
  ↓
proposePromptPatch(patrón) — Claude Sonnet sugiere fix
  ↓
recordProposedPatch() → proposals.jsonl (status='pending')
  ↓
/admin "Prompt patches" → muestra pending proposals
  ↓
Owner aprueba: POST /api/admin/prompt-patches/[id]/decide { approved: true }
  ↓
applyPatch(id) — (GATED, nunca auto)
  ├─ Lee archivo target
  ├─ Ubica template literal del SYSTEM_PROMPT por varName (regex defensivo)
  ├─ Aplica oldText → newText DENTRO de backticks
  ├─ Typecheck (si rompe → revert)
  └─ updatePatchStatus() → status='applied'
  ↓
Owner commitea cambio cuando lo decide
```

**Invariante clave** (línea:581-668): `applyPatch` es la ÚNICA excepción a "nada se auto-aplica" — pero REQUIERE owner approval (status='pending' → 'approved') antes de applyPatch().

### Flujo 4: Compuerta de Calidad sobre Render

```
(Pipeline produce render finalizado)
  ↓
runQualityGate({ runId }, opts)
  ├─ Localiza run en storage/runs/{runId}
  ├─ (Opt) deriveRubric() — contexto determinista desde formato aprendido
  ├─ runFormatAudit() — panel multi-agente (Gemini ve+oye)
  │  └─ 6 especialistas + verificador (dimensiones: composición, animación, voces, producto, anotaciones, fidelidad)
  ├─ Persistencia: format-reports/{scope}.json
  ├─ decideGateVerdict(hallazgos, policy) — PURA, sin IA
  │  ├─ Cuenta hallazgos por severidad
  │  ├─ failOn='critical' (algún critical sin descartar)
  │  ├─ reviewOn='high' (algunos high) O ≥3 medium
  │  └─ veredicto: 'pass' | 'revisar' | 'fail'
  └─ writeQualityGateReport() → quality-gates/{scope}.json
  ↓
Pipeline.finalStatus:
  ├─ Si veredicto='pass' → 'completed'
  ├─ Si veredicto='revisar' → 'completed-with-warnings' (bloqueante suave)
  └─ Si veredicto='fail' → 'completed-with-warnings' (marcado "NO VERIFICADO", fail-loud)
  ↓
RunViewer /runs/[id] muestra GateFindings (hallazgos + fixPropuesto)
  ↓
Owner puede:
  ├─ POST /api/runs/[id]/gate/repair { sceneIndex?, fixType } → executeGateRepair()
  │  ├─ planRepairs() decide qué escena regenerar/re-animar (Fase 2 "brazo")
  │  └─ applyCorrection() + regenerar esa escena SOLA (fast)
  └─ O editar manual + re-render
```

**Guarantía**: NADA se auto-aplica (even though hallazgos tienen `fixPropuesto`). El dueño decide si aplicar el repair; ejecutaGateRepair siempre fuerza OK explícito (POST, no GET).

## Invariantes y Gotchas Clave

1. **Bridge M9 (system-log ↔ KB)** — `systemEventToKb` es la ÚNICA vía que eventos llegan a la KB. Si tocas un stage del pipeline, emite vía `logSystemEvent`, NUNCA crees un emisor paralelo a `recordEvent` (invariante 'kb-fed-by-system-log', línea:64-72 invariants.ts). **Gotcha histórico**: jun-2026 casi se duplicó el feed con un `run-events.ts` paralelo.

2. **Nada se Auto-Aplica** (invariante línea:55-62) — Sistema PROPONE (hallazgos, patches, repairs), owner APRUEBA. Único exception: `applyPatch` PERO requiere owner approval primero (status pending → approved). Si alguien tries a auto-aplicar cambios sin gating, las invariantes de seguridad entran en fuego.

3. **CORE_INVARIANTS Seed** (línea:42-276 invariants.ts) — Si la KB está vacía, `listInvariants()` (línea:299) devuelve la semilla CORE + la materializa append-only al file (línea:336-339). Eso evita que se pierdan las reglas del proyecto si el file se borra.

4. **Codebase Freshness via Caching** (línea:260-276 deep-audit.ts) — `lastAudit` por subsistema guardaCodeVersion + ts. Si codeVersion no cambió Y sin eventos nuevos → SALTA (ahorro huge). Pero si alguien reescribe el archivo sin cambiar el commit hash (⚠️ raro), deepAudit lo perderá. **Mitigation**: force=true overrides caché.

5. **Español Neutro SIEMPRE** (invariante línea:44-53) — Voseo es bloqueante critical en quality-gate.ts (neutral-es.ts detectVoseo). Límite: imperativos voseo homógrafos del pretérito (descubrí/salí sin -s) NO se corrigen sin contexto — se marcan como "incierto".

6. **Storage Unificado** (invariante línea:74-81) — VF_STORAGE_DIR (forced by next.config.mjs) = `<root>/storage`. Record.ts, prompt-evolution.ts, system-log.ts TODOS usan `process.env['VF_STORAGE_DIR']` con fallback candidates (scripts sin next.config). Si uses process.cwd() para storage, será split-brain (antes fue bug).

7. **Validación SIEMPRE** (invariante línea:234-243) — Quality-gate corre OBLIGATORIA al terminar cada render (await runQualityGate, finalStatus depende de gateVeredicto). NO opt-in (VF_GATE_ON_RENDER DELETED). Test guardian `quality-gate-wiring.test.ts` (línea:242 invariants.ts) ROMPE si alguien lo desconecta.

8. **Pre-digerido, NO Dumps Crudos** — `buildContextFor` sintetiza contexto CHICO (~3500 chars max) para especialistas, no manda todo el EVENTOS_DIR. Evita perder output por context length. Ahorro de KB es eso: pre-digerir en vez de esperar a que Claude lea 100k logs.

9. **Hallazgos + Fase 2 Brazo** (línea:42-46 findings.ts) — `startSec`/`endSec`/`sceneIndex` son OPCIONALES (presentes solo si se pudo localizar defecto en tiempo/escena). Si solo tienes hallazgo textual (deep-audit), dejas null. El brazo (reparación dirigida) es Fase 2 (implementación en repair-loop.ts + repair-executor.ts).

10. **Robustez Schemas** (línea:32-77 deep-audit.ts) — Truncan en vez de rechazar. Si un field sale out-of-range (severidad=`"invalid"`, confidence=-50), `.catch()` lo normaliza en vez de tumbar el hallazgo. Evita perder toda la auditoría por 1 hallazgo malformado (bug histórico).

11. **Auto-Fix vs Auto-Apply** — `auto-fix.ts` (línea:1-431) es la ÚNICA excepción a la invariante "nada se auto-aplica", pero SOLO para bugs menores (typos, missing imports, type casts) con confidence ≥85. Riesgos altos (>30 líneas, unsafe paths, forbidden files) quedan queued-for-review. Esto es por diseño: auto-fix es para errores obvios repetibles; cambios sistémicos pasan por cerebro evolutivo (propuesto, owner aprueba).

12. **Deepfraud pero Bien-Estructurado** — Deep-audit NO es un "free chat" entre agentes. Cada especialista tiene una tarea específica, recibe contexto PEQUEÑO, devuelve JSON schema STRICT. Verificador intenta refutar. Síntesis es determinista (dedup + ranking). Esto es MUCHO más barato + confiable que agentes conversacionales.

## Diagrama de Wiring

```
┌─────────────────────────────────────────────────────────────────┐
│ M9: SYSTEM CONTEXT + AUTO-LOG                                   │
├─────────────────────────────────────────────────────────────────┤
│ buildSystemContext() ← system-context.ts:303                    │
│   ├─ Brands, Presets, Providers (detecta de env)                │
│   ├─ recentEventsFormatted ← formatRecentEventsForContext()     │
│   │   ↓ readRecentEvents() ← system-log.ts:158                  │
│   └─ presetConfidenceFormatted ← getPresetConfidenceScores()    │
│       (M7 #3 feedback loop)                                     │
│                                                                  │
│ + formatInvariantsForContext() ← invariants.ts:349              │
│   (inyecta reglas duras a system prompt)                        │
│                                                                  │
│ ↓ Cada llamada a Claude recibe contexto vivo                    │
└─────────────────────────────────────────────────────────────────┘
         ↓ (pipeline/editor/validador/chat emite eventos)
┌─────────────────────────────────────────────────────────────────┐
│ BRIDGE M9: logSystemEvent ← system-log.ts:129                   │
├─────────────────────────────────────────────────────────────────┤
│ append a storage/system-log.jsonl                               │
│   ↓ systemEventToKb()                                           │
│   ↓ recordEvent() ← record.ts:79 (Fase 0)                       │
│   ↓ append a eventos/{subsistema}.jsonl + índice                │
└─────────────────────────────────────────────────────────────────┘
         ↓ (próximo deep-audit/query ve el evento)
┌─────────────────────────────────────────────────────────────────┐
│ FASE 1: QUERY ← query.ts:81                                     │
├─────────────────────────────────────────────────────────────────┤
│ Consulta eventos por filtros (cero IA)                          │
│   ↓ buildContextFor(subsistema, maxChars) → pre-digerido        │
│     para especialista en deep-audit                             │
└─────────────────────────────────────────────────────────────────┘
         ↓ (auditoría on-demand O auto-triggered)
┌─────────────────────────────────────────────────────────────────┐
│ FASE 2: DEEP-AUDIT ← deep-audit.ts:227                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. Especialistas (1/subsistema) — mandato adversarial           │
│ 2. Verificador — intenta refutar (falso-positivo killer)        │
│ 3. Síntesis IA superior — dedup + ranking + próximo paso        │
│   ↓ recordHallazgo() ← findings.ts:54                           │
│     append a hallazgos/findings.jsonl                           │
│   ↓ Reflejar a KB como evento (tipo hallazgo-auditoria)         │
│   ↓ writeLastAuditReport() → hallazgos/last-report.json         │
│     (mostrado en /admin "Consejo")                              │
└─────────────────────────────────────────────────────────────────┘
              ↓ (owner ve hallazgos en /admin)
         ┌────┴────┐
         ↓         ↓
    REPAIR    MANUAL FIX
    (gate)      (editor)
         ├────┬────┤
         ↓    ↓    ↓
    [ Fase 2: planRepairs (repair-loop.ts) → decision determinista ]
    [ executeGateRepair (repair-executor.ts) → regenera escena ]
    [ Owner aprueba: POST /api/runs/[id]/gate/repair ]
```

**Separado: Cerebro Evolutivo**

```
┌──────────────────────────────────────────────────────────┐
│ PROMPT EVOLUTION ← prompt-evolution.ts:328               │
├──────────────────────────────────────────────────────────┤
│ detectSystemicPatterns(opts) — escanea últimos 30 días   │
│   Lee: system-log.jsonl + post-render-reports.json       │
│   Agrupa errores por categoría                           │
│   Filtra: minOccurrences (default 3)                     │
│   Devuelve: SystemicPattern[]                            │
│                                                          │
│ proposePromptPatch(patrón) — Claude Sonnet sugiere       │
│   recordProposedPatch() → proposals.jsonl                │
│   Status: 'pending'                                      │
│                                                          │
│ ↓ Owner aprueba en /admin                                │
│                                                          │
│ applyPatch(id) — GATED (nunca auto)                      │
│   ├─ Backup archivo target                              │
│   ├─ Ubicar template literal (regex defensivo)           │
│   ├─ Reemplazar oldText → newText DENTRO backticks       │
│   ├─ Validar: no backticks en oldText/newText            │
│   ├─ Typecheck (si rompe → revert)                       │
│   └─ Status: 'applied' (owner commitea después)          │
└──────────────────────────────────────────────────────────┘
```

## Storage Layout

```
storage/
├── kb/                            (Base de Conocimiento)
│   ├── invariantes.jsonl          (append-only, última por id gana)
│   ├── eventos/                   (Fase 0: recolección)
│   │   ├── pipeline.jsonl
│   │   ├── validator.jsonl
│   │   ├── chat.jsonl
│   │   ├── aprendizaje.jsonl
│   │   ├── compositor.jsonl
│   │   ├── seguridad.jsonl
│   │   ├── ux.jsonl
│   │   ├── image-gen.jsonl
│   │   ├── animacion.jsonl
│   │   └── otro.jsonl
│   ├── indice/
│   │   └── por-entidad.json       (índice para ubicación rápida)
│   ├── hallazgos/                 (Fase 2: auditoría)
│   │   ├── findings.jsonl         (append-only hallazgos)
│   │   ├── last-audit.json        (caché codeVersion+ts por subsistema)
│   │   ├── last-report.json       (resumen ejecutivo para /admin)
│   │   ├── format-reports/        (scoped por runId/presetId)
│   │   │   ├── {scope}.json
│   │   │   └── _latest.json
│   │   └── quality-gates/         (veredictos de compuerta)
│   │       ├── {scope}.json
│   │       └── _latest.json
│   ├── auto-audit-cursor.json     (contador runs + ts última auditoría)
│   └── auto-audit-config.json     (enabled flag, every, maxHours)
│
├── prompt-patches/
│   └── proposals.jsonl            (append-only propuestas, última por id gana)
│
├── auto-fix/                      (auto-fix: generador de bugs automático)
│   ├── queue.jsonl                (errores a procesar)
│   ├── processed.jsonl            (errores ya procesados)
│   ├── journal.jsonl              (log de applies)
│   └── backups/                   (backups pre-apply)
│
├── system-log.jsonl               (M9 auto-log: todos eventos)
│
└── runs/                          (outputs de runs)
    ├── {runId}/
    │   ├── scene-plan.json
    │   ├── scenes/
    │   ├── rendered.mp4
    │   ├── post-render-report.json
    │   ├── editor-conversation.md
    │   └── gate-report.json (si corre compuerta)
```

## Estados y Transiciones

### Hallazgo

```
Estado: 'abierto' (nuevo) → 'confirmado' (verificador OK) | 'falso-positivo' (matado) | 'arreglado' (fixed aplicado) | 'descartado' (owner NO quiere fijar)
```

### Patch Evolutivo

```
Status: 'pending' (propuesta) → 'approved' (owner OK) → 'applied' (escrito a archivo)
                              ↘ 'rejected' (owner NO)
```

### Quality Gate

```
Veredicto: 'pass' (OK) → finalStatus='completed'
           'revisar' (avisos suave) → finalStatus='completed-with-warnings'
           'fail' (bloqueante) → finalStatus='completed-with-warnings' + "NO VERIFICADO"
```

### Auto-Fix

```
Status: 'applied' (confidence ≥85 + low risk)
        'queued-for-review' (60-84 confidence O medium risk)
        'rejected-too-risky' (unsafe O >30 líneas)
        'no-fix-found' (confidence <60)
        'apply-failed-reverted' (typecheck falló → rollback)
        'forbidden-path' (.env, db, node_modules, etc.)
```

**⚠️ Gotchas (10-kb-cerebro-consejo: Base de Conocimiento + Cerebro Evolutivo de Video Factory):**
- Bridge M9 (systemEventToKb) es ÚNICA vía a KB desde pipeline — NO crear emisores paralelos a recordEvent (invariante clave, bug histórico jun-2026).
- Auto-audit caché por codeVersion — si reescribes archivo sin cambiar commit hash, deepAudit lo perderá (mitigación: force=true).
- Quality-gate OBLIGATORIA (await runQualityGate, finalStatus depende veredicto). Test guardian rompe si desconectas. NO opt-in.
- Prompt-evolution propone patches pero NUNCA auto-aplica sin OK owner (gating invariante crítica, única excepción es auto-fix para bugs obvios <85% confidence).
- Storage unificado via VF_STORAGE_DIR (forced next.config.mjs) — proceso.cwd() para storage → split-brain. scripts fallback a candidates.
- CORE_INVARIANTS seed materializa al file la primera vez que KB está vacía — si file se borra, regresa la semilla.
- Hallazgos + startSec/endSec/sceneIndex son OPCIONALES — solo presentes si se localizó defecto en tiempo/escena (Fase 2 brazo).
- Schemas deep-audit TRUNCAN en vez rechazar (severidad/números con .catch) — evita perder auditoría entera por 1 hallazgo malformado.
- Español neutro SIEMPRE (invariante crítica) — voseo bloqueante critical en quality-gate. Límite: imperativos homógrafos sin contexto = incierto.
- Auto-fix (única excepción nada-se-auto-aplica) solo para confidence ≥85 + low-risk <30 líneas. Riesgos altos → queued-for-review. Backups siempre.


---

# Subsistema 11: Validador Chat IA (M8 + M9 + Validators)

## Propósito y Alcance

Este subsistema orquesta la **validación de calidad mediante Chat IA conversacional** en Video Factory. Integra:

1. **M8 — ClaudeChatPanel + Copilot**: componente reusable de chat conversacional plugeado en 7 rutas principales (sugerencias, create, rip, runs/editor, admin, aprendizaje, arquitecto).
2. **M9 — System Context + Auto-Log**: inyecta snapshot del proyecto (brands, presets, providers, decisiones) en TODOS los Claude callers; registra eventos automáticamente a `storage/system-log.jsonl`.
3. **Judges unificados (M7 Pieza C)**: primitivos en `packages/core/src/claude-judge.ts` + wrapper app-level en `apps/web/lib/unified-judge.ts` que auto-inyecta contexto M9.
4. **Guardián de español neutro**: `toNeutralSpanish()` + `detectVoseo()` en `neutral-es.ts`, reutilizado por chat, pipeline y quality-gate.
5. **Quality Gate (compuerta)**: envuelve panel de especialistas (format-audit) + determinista verdict + repair-loop.

End-to-end: usuario escribe en chat → Claude razona con contexto actual del sistema → respuesta normalizada en español neutro → evento loggeado → KB alimentada → próxima llamada IA ve el historial.

---

## Arquitectura: las 5 categorías de Chat

### 1. **Sugerencias** (`contextType: 'sugerencia'`)

**Ubicación**: `/sugerencias` + `ClaudeChatPanel` + `POST /api/chat/discuss`

**Rol del asistente** (apps/web/lib/claude-chat-discuss.ts:75-76):
> Ayudas al owner a refinar una sugerencia de mejora antes de que la registre formalmente. Discute pros/contras, sugiere variantes, menciona si algo similar ya existe, estima rough esfuerzo.

**Contexto inyectado (M9)**:
- Brands, presets activos/pending
- Providers configurados
- Eventos recientes (últimos 12)
- Decisiones de diseño vigentes
- Ranking de presets por confidence (M7 #3 feedback loop)

**Invariantes respetados**:
- Español neutro estricto (voseo → "tú")
- System context completo (NO es copilot — ve datos internos)
- Nada se auto-aplica (solo propone)

---

### 2. **Scene Edit** (`contextType: 'scene-edit'`)

**Ubicación**: `/runs/[id]/editor` en el panel de edición de escenas

**Rol** (claude-chat-discuss.ts:77-78):
> Ayudas al owner a editar una escena específica del video. Conoces el prompt original, el preset y contexto narrativo. Sugiere cambios concretos al prompt y alerta sobre limitaciones del modelo de imagen.

**Contexto especial**:
- Scene data (prompt, preset, index)
- Video metadata
- Route profile resoluta (`route-profiles.ts`)

---

### 3. **Script Refine** (`contextType: 'script-refine'`)

**Ubicación**: `/create` — antes de generar el video

**Rol** (claude-chat-discuss.ts:79-80):
> Revisa el hook (primeros 3s), estructura AIDA/PAS, claims del producto (verifica compliance médico), CTA. Sugiere ajustes concretos. Si viola claim médico (Vitaly = suplemento), alerta.

**Guard rails**: detecta violaciones de compliance en el guion antes de que se genere TTS.

---

### 4. **Rip Analysis** (`contextType: 'rip-analysis'`)

**Ubicación**: `/rip/[id]` — post-análisis de ad referencia

**Rol** (claude-chat-discuss.ts:81-82):
> Ayuda al owner a interpretar el análisis multimodal de un ad de referencia (estilo, hook, paleta, personaje). Responde preguntas sobre cómo adaptarlo a otro producto/marca, qué preset elegir, qué ajustar.

**Contexto**:
- `AdAnalysis` del video ripeado (M7-A: video-understander)
- Presets sugeridos
- Brand/producto a adaptarse

---

### 5. **Preset Tuning** (`contextType: 'preset-tuning'`)

**Ubicación**: `/admin` — ajuste de presets

**Rol** (claude-chat-discuss.ts:83-84):
> Ayuda al owner a ajustar un preset (promptTemplate, negativePrompt, scenesPerMinute, etc.) basado en feedback de runs. Sugiere ajustes específicos y por qué.

**Contexto especial**:
- Preset actual completo
- Runs recientes con ese preset
- Confidence scores históricos

---

### 6. **Arquitecto IA** (`contextType: 'architect'`)

**Ubicación**: `/admin` — consola del arquitecto (especial)

**Rol** (claude-chat-discuss.ts:95-134):
- **Modelo escalado**: `claude-sonnet-4-5` (no haiku)
- **Visión sistémica**: razona sobre rutas, profiles, tratamientos
- **Detecta "acá es diferente"**: cuándo un tipo de video necesita ruta distinta
- **Propone cambios CONCRETOS** (con OK del owner): qué archivo/config, por qué, riesgo

**Inyecta `describeRouteProfiles()`** (route-profiles.ts:194-200):
```
Cada tipo de video resuelve un perfil que define su tratamiento.
anatomyMode controla qué tan estricto es el validator con anatomía humana;
animación = Ken Burns vs image-to-video real.
```

**Perfiles vivos** (route-profiles.ts:58-162):
- `cartoon-3d` (Pixar/claymation): anatomyMode=lenient, animation=ken-burns
- `illustrated` (acuarela/comic): anatomyMode=lenient, animation=ken-burns
- `ugc-real` (realista/selfie): anatomyMode=strict, animation=real
- `default` (genérico): anatomyMode=strict, animation=real

**No modifica código solo**: propone → owner aprueba → apply patch. Respeta `nada-auto-aplica`.

---

### 7. **Copilot** (`contextType: 'copilot'`)

**Ubicación**: Burbuja flotante de ayuda (de cara al usuario final, NO técnico)

**Rol especial** (claude-chat-discuss.ts:139-204):
- Respuestas CORTAS (1-4 frases)
- Español neutro estricto
- SIN tecnicismos
- Nunca menciona roles, permisos, internals
- Puede mostrar **catálogo de marcas/estilos** (ids reales) para prellenar brief

**DEFENSA EN PROFUNDIDAD**: NO recibe `getSystemContextForPrompt()` (claude-chat-discuss.ts:258-267).
- Sí recibe: catálogo de marcas/estilos públicos (buildCopilotCatalog:209-230)
- No recibe: proveedores, claves, decisiones internas, eventos del sistema

**Bloques Copilot especiales** (claude-chat-discuss.ts:192-200):
- `[[BRIEF]]` + JSON → crea video
- `[[SUGERENCIA]]` + JSON → reporta problema/feature

---

## Flujo End-to-End: Chat Discuss

### 1. Frontend (ClaudeChatPanel.tsx:71-117)
```typescript
send(e: FormEvent):
  // user escribe → newMessages.push(userMsg)
  // setInput('') + setSending(true)
  // POST /api/chat/discuss con {contextType, contextData, conversation: [...]}
  // response.reply → newMessages.push(assistantMsg)
  // onReply(reply) callback
  // scroll smooth + setSending(false)
```

**Estados locales**: messages[], input, sending, error.
**Sin Redux/Zustand**: conversación efímera, no persiste (salvo chat-log de auditoría).

### 2. API Route (app/api/chat/discuss/route.ts:20-68)
```typescript
POST /api/chat/discuss:
  // 1. isAuthenticated() → 401 si no
  // 2. ChatDiscussRequestSchema.safeParse(body) → 400 si inválido
  // 3. Verifica ANTHROPIC_API_KEY en process.env → 503 si no
  // 4. discussWithClaude(parsed.data) → ChatDiscussResponse
  // 5. appendChatLog({contextType, userMessage, reply, page})
  // 6. return reply JSON
```

**Seguridad**: sesión requerida (no público). Context interno solo se inyecta dentro de discussWithClaude, no vuelve al frontend.

### 3. Core Logic (lib/claude-chat-discuss.ts:240-342)
```typescript
discussWithClaude(request):
  // 1. Elige model (architect→sonnet-4-5, resto→haiku-4-5)
  // 2. roleSystemPrompt = systemPromptFor(contextType, contextData)
  // 3. Si contextType != 'copilot':
  //    projectContext = await getSystemContextForPrompt() [M9]
  // 4. systemPrompt = projectContext + "\n---\n" + roleSystemPrompt
  // 5. fetch ANTHROPIC_URL con {model, messages, system, temperature:0.4}
  // 6. extractFinalText(response) → respuesta bruta
  // 7. toNeutralSpanish(reply) → español neutro
  // 8. logSystemEvent({kind:'chat-discuss-message', ...})
  // 9. return {reply, elapsedSec, modelUsed, tokensUsed}
```

**Puntos críticos**:
- `temperature: 0.4` (conversacional, no deterministico como validators)
- Última validación: español neutro via `toNeutralSpanish` (linea 312)
- Auto-log de evento (linea 319) → alimenta M9
- Conversation valida: último msg debe ser user (linea 283)

---

## M9: System Context & Auto-Log

### System Context (lib/system-context.ts)

**Función principal**: `getSystemContextForPrompt(): Promise<string>`

Arma snapshot COMPLETO inyectado como system prompt prefix a TODOS los Claude callers:
- Identidad del proyecto
- Modos operativos (crear, ripear, aprender)
- Capa IA actual (M1-M9, ubicaciones)
- Brands disponibles (id, displayName, productCount, hasLogo)
- Presets (active/pending: id, displayName, formatId, styleId, visualEngine, estrategia)
- Providers detectados (image/animation/tts)
- Decisiones de diseño vigentes
- Eventos recientes del sistema (últimos 12, hasta 2000 chars)
- Preset confidence scores (M7 #3 feedback loop)
- **Invariantes del proyecto** (si `formatInvariantsForContext()` no falla)

**Detección de providers** (system-context.ts:193-220):
```
if (OPENAI_API_KEY) → openai:gpt-image-1, openai:tts-1
if (GOOGLE_AI_API_KEY) → gemini:nano-banana, google:imagen4
if (GCP_PROJECT_ID) → vertex:imagen, vertex:veo
if (HIGGSFIELD_KEY_ID) → higgsfield:flux-pro-kontext
if (KLING_ACCESS_KEY) → kling:v2-6
if (FAL_API_KEY) → fal:flux-pro
if (ELEVENLABS_API_KEY) → elevenlabs
```

**Costo**: ~10-20ms por call (sin caché, porque log + presets cambian entre llamadas).

### Auto-Log (lib/system-log.ts)

**Ruta**: `storage/system-log.jsonl` (append-only, nunca sobrescribe)

**Función principal**: `logSystemEvent(event: Omit<SystemEvent, 'ts'>): Promise<void>`

Cada evento significativo → JSON line a system-log:
```json
{
  "ts": "2026-06-08T14:23:45.123Z",
  "kind": "chat-discuss-message|run-completed|editor-ia-verdict|...",
  "data": { contextType, userMessageLength, replyLength, model, tokensIn, tokensOut, ... },
  "summary": "[timestamp] chat sugerencia: \"usuario pregunta...\" → reply 234ch"
}
```

**Kinds soportados** (system-log.ts:32-46):
- run-started, run-completed, run-failed
- preset-created, preset-approved
- editor-ia-action, editor-ia-verdict
- suggestion-posted, scene-regenerated, auto-learn-invoked
- chat-discuss-message, video-understood, config-changed, other

**Bridge a KB** (system-log.ts:61-121):
```typescript
systemEventToKb(event):
  // Mapea SystemEvent → RecordInput (esquema KB)
  // Routing determinista por kind → subsistema (pipeline, aprendizaje, validator, otro)
  // Categoría severidad: info → high (si run-failed)
  // NUNCA duplica: chat-discuss-message + suggestion-posted = null (tienen emisores dedicados)
```

**No falla silencioso**: lógica `void` en line 144 (recordEvent best-effort).

---

## Judges Unificados (M7 Pieza C)

### Nivel Core (packages/core/src/claude-judge.ts)

**Primitivos reutilizables**:

1. **callAnthropicMessages(opts)**:
   - HTTP wrapper puro a Anthropic Messages API
   - Timeout, headers, error handling
   - Soporta extended thinking (Sonnet 4-5)
   - Retorna `Result<ClaudeResponse, ClaudeApiError>` (neverthrow)

2. **extractJsonFromClaudeText(rawText)**:
   - Parser tolerante (markdown fences, texto natural pre/post, whitespace)
   - Busca `{...}` o `[...]` si no empieza con esos chars
   - Retorna `Result<unknown, ClaudeApiError>`

3. **judgeWithClaude<TSchema>(opts)**:
   - Combinación: call + extract + Zod.safeParse
   - Usa schema genérico `z.ZodTypeAny`
   - Retorna `Result<z.infer<TSchema>, ClaudeApiError>`

**Helpers**:
- `extractFinalText(response)`: filtra bloques 'thinking' si extended thinking ON
- `extractThinking(response)`: devuelve razonamiento interno
- `buildImageMessageContent(buffer, text, mimeType)`: arma content array con imagen base64

### Nivel App (apps/web/lib/unified-judge.ts)

**Wrapper de alto nivel** que auto-inyecta system-context:

```typescript
unifiedJudge<TSchema>(opts):
  // 1. Si !skipProjectContext: projectContext = await getSystemContextForPrompt()
  // 2. fullSystem = projectContext + "\n---\n# Tu rol actual\n" + roleSystemPrompt
  // 3. judgeRaw({..., system: fullSystem, ...})
```

**Defaults**:
- model: `claude-haiku-4-5` (rápido/barato)
- maxTokens: 1500
- temperature: 0 (determinístico)
- timeoutMs: 30000

**Skip context**: `skipProjectContext: true` para tareas binarias triviales.

---

## Guardián de Español Neutro

### neutral-es.ts

**Lista única compartida de voseo** (VOSEO_MAP: 30+ formas):

```typescript
// Imperativos acentuados (inequívocos)
mirá→mira, hacé→haz, vení→ven, ...
// Presente 2ª persona (-ás/-és/-ís acentuado)
tenés→tienes, querés→quieres, podés→puedes, ...
// Adverbio regional
acá→aquí
```

**Funciones**:
- `toNeutralSpanish(text)`: replace palabra-por-palabra, preserva mayúscula inicial
- `detectVoseo(text)`: devuelve Set de formas voseo encontradas (para guardián)

**Diseño CONSERVADOR**:
- Lookup exacto (no patrón)
- NO corrige homógrafos pretérito (salí/sentí/descubrí sin -s) sin contexto
- "sos" (sigla SOS) fuera de rango

**Reutilización compartida**:
- Chat (claude-chat-discuss.ts:312)
- Pipeline guion (pipeline.ts normaliza antes de TTS)
- Quality gate (kb/quality-gate.ts:30 detecta voseo como bloqueante)

---

## Quality Gate: La Compuerta (kb/quality-gate.ts)

**NO es un validator paralelo**: es ENVOLTORIO + derivador DETERMINISTA de hallazgos.

### Función Principal: runQualityGate(runId, opts)

```
1. Carga metadata del run (preset, brand, scenes)
2. Resuelve route profile (route-profiles.ts resolveRouteProfile)
3. (Opcional) deriveRubric → afina briefing del panel
4. Corre runFormatAudit (panel especialistas)
5. decideGateVerdict → pass/revisar/fail DETERMINISTA
6. Persiste QualityGateReport
```

### Rúbrica (deriveRubric)

DETERMINISTA (sin IA), hermana de `planTimelineFromFormat`:
- Deriva criterios del formato aprendido
- Dimensiones: composicion-recorte, animacion-movimiento, voces-diarizacion, producto-legibilidad, captions-anotacion, fidelidad, global
- **Anti-falsos-positivos**: nunca crea criterio cuyo soporte sea null
- Ej: sin producto → sin criterio de legibilidad de producto

### Política de Veredicto (GatePolicy)

```typescript
failOn: 'critical' | 'high' (default 'critical')
reviewOn: 'medium' | 'high' (default 'high')
reviewOnMediumCount: number (default 3)
countUnverified: boolean (default true — fail-safe)
```

Función pura: `decideGateVerdict(findings, policy)` → 'pass' | 'revisar' | 'fail'

### Repair Loop (Fase 2 código cerrado)

**Contrato tipado**:
- `planRepairs(findings)` → propone reparaciones dirigidas
- `executeGateRepair(repairId, runId)` → ejecuta con OK del owner (forkea run)

Viven en:
- Decisión: `kb/repair-loop.ts`
- Ejecución: `repair-executor.ts`
- UI: `/runs/[id]/GateFindings.tsx`

---

## Montaje: Dónde se Plugea

### ClaudeChatPanel Placements

1. `/sugerencias` — panel para reportar mejoras
2. `/create` — refinar script antes de generar
3. `/rip/[id]` — entender análisis ripeado
4. `/runs/[id]/editor` — editar escena + chat
5. `/admin` — tuning de presets + arquitecto
6. `/aprendizaje/[id]` — discutir preset aprendido
7. Posibles futuras: `/admin/consejo` (consejo de mejora continua)

### Invariantes Respetados

1. **Idioma** (CORE_INVARIANT: idioma-neutro)
   - Toda salida Chat IA → toNeutralSpanish()
   - Quality gate detecta voseo como bloqueante (critical)

2. **Nada se auto-aplica** (CORE_INVARIANT: nada-auto-aplica)
   - Chat propone, owner aprueba
   - Repair loop OK explícito del owner

3. **KB alimentada vía system-log** (CORE_INVARIANT: kb-fed-by-system-log)
   - logSystemEvent → systemEventToKb
   - NO emisores paralelos

4. **Storage unificado** (CORE_INVARIANT: storage-unificado)
   - Todo en VF_STORAGE_DIR (next.config override)
   - system-log.jsonl, quality-gate-report.json, etc.

5. **Contexto M9 inyectado SIEMPRE** (excepto Copilot)
   - getSystemContextForPrompt() llamada al inicio de discussWithClaude
   - Claude ve state actual: brands, presets, providers, decisiones, eventos

---

## Anti-Patrones Detectados (5 Categorías de Guardia)

### 1. **Voseo Residual**
**Trap**: Claude a veces cuela voseo en español "neutro".
**Guard**: `toNeutralSpanish()` post-response + `detectVoseo()` en quality-gate bloqueante (critical).
**Código**: neutral-es.ts:40-46; claude-chat-discuss.ts:312; quality-gate.ts:detectVoseo.

### 2. **Context Injection Falsa (Copilot leak)**
**Trap**: Pasar contexto interno (providers, claves, prompts) al Copilot (de cara al usuario).
**Guard**: Condicional explícito `if (contextType !== 'copilot')` línea 261; Copilot recibe SOLO catálogo público.
**Código**: claude-chat-discuss.ts:258-277.

### 3. **Modelo Equivocado para el Rol**
**Trap**: Usar Haiku para arquitecto (reasoning > velocidad necesaria).
**Guard**: Escalado explícito `contextType === 'architect' ? 'claude-sonnet-4-5' : 'claude-haiku-4-5'`.
**Código**: claude-chat-discuss.ts:249-251.

### 4. **Duplicate KB Feed**
**Trap**: Crear emisor paralelo a recordEvent para chat-discuss-message, suggestion-posted.
**Guard**: systemEventToKb retorna `null` para esos kinds (línea 62-63); bridge ÚNICO.
**Código**: system-log.ts:61-121.

### 5. **Auto-Apply sin Aprobación**
**Trap**: Cambios de prompt/config que se aplican sin OK del owner.
**Guard**: Nada en discussWithClaude modifica storage; repair-loop exige OK explícito vía endpoint POST.
**Código**: invariants.ts:nada-auto-aplica; prompt-evolution.ts applyPatch gated.

---

## Wiring No-Obvio

### M9 ← System-Log Bridge
```
logSystemEvent(event) 
  → systemEventToKb(event) 
  → recordEvent(kb) [fire-and-forget]
  → storage/kb/eventos/*.json
```
Luego: `buildSystemContext()` lee recent events → formatting → inject en prompts.

### Route Profile Resolver
```
route-profiles.ts resolveRouteProfile(styleBase, formatId, styleId)
  → busca match por formatId/styleId exacto, luego styleKeywords
  → retorna profile (cartoon-3d, illustrated, ugc-real, default)
  → quality-gate usa profile para DEFENSA CORRECTA (anatomyMode, animation)
```

### Copilot Brief Embedding
```
[[BRIEF]]{"script":"...", "brandId":"...", "presetId":"...", voice:true, ...}[[/BRIEF]]
  → Frontend parsea regex, prellenamos UI create
[[SUGERENCIA]]{"titulo":"...", "descripcion":"...", "categoria":"feature"}[[/SUGERENCIA]]
  → POST /api/sugerencias crea suggestion
```

---

## Estado Real (Código Vivo, Junio 2026)

**Implemented & Tested**:
- Chat discuss (M8) robusto en 7 rutas
- System context (M9) snapshot completo, 10-20ms
- Judges unificados (M7-C) sin duplicación
- Español neutro guardián (reutilizado chat + pipeline + quality-gate)
- Route profiles 4x (cartoon-3d, illustrated, ugc-real, default)
- Quality gate compuerta + rúbrica determinista
- Repair loop fase 2 (código cerrado, OK del owner requerido)

**Pending / Observaciones**:
- Motion detection (animado vs estático) en video-understander (invariant deteccion-patrones-animacion)
- Surfaceando hallazgos en editor UI (GateFindings se muestra en RunViewer, pendiente aplicación copilot-driven)
- Aprendizaje pasivo en circuito 8 (sistema corrige sola pero no memoriza el patrón evitar repe­tición)

---

## Para Próxima Sesión (Nuevos Clones)

1. **Lee PRIMERO**: CLAUDE.md invariantes + route-profiles.ts + quality-gate.ts
2. **Tests existentes**: quality-gate-wiring.test.ts (guardián anti-regresión), neutral-es.test.ts
3. **Puntos de entrada**:
   - Chat: `POST /api/chat/discuss` → lib/claude-chat-discuss.ts `discussWithClaude()`
   - Context: `getSystemContextForPrompt()` → lib/system-context.ts
   - Quality: `runQualityGate(runId)` → lib/kb/quality-gate.ts
   - Español: `toNeutralSpanish(text)` + `detectVoseo(text)` → lib/neutral-es.ts
4. **Cambios requieren**: orden explícita del owner (commits, git push, auto-apply).

**⚠️ Gotchas (11-validador-chat-ia):**
- Contexto M9 NUNCA se inyecta al Copilot (de cara usuario): condicional explícito en línea 261 (contextType !== 'copilot'). Si lo cambias, filtras datos internos.
- Voseo residual: toNeutralSpanish() es post-fetch, NO pre-prompt. Diseño: dejar que Claude responda natural, normalizar salida. Quality-gate detecta como bloqueante (critical) si queda voseo en el guion antes de TTS.
- Duplicate KB feed: systemEventToKb retorna null para chat-discuss-message y suggestion-posted (tienen emisores dedicados). NO agregar paralelamente recordEvent o lo duplicarías.
- Modelo escalado: arquitecto → sonnet-4-5, resto → haiku-4-5. Si cambias default, revisa tests y performance/costo.
- Route profile resolver: primero exacto (formatId/styleId), luego keywords. Orden de PROFILES importa (primero específicos). Default replica comportamiento histórico (estricto), garantiza retrocompatibilidad.
- Quality gate: NO IA en decideGateVerdict (función pura, testeable). Rúbrica (deriveRubric) es DETERMINISTA (no inventa criterios cuyo soporte sea null). Repair loop Fase 2 requiere OK explícito del owner (POST endpoint).
- Temperatura chat: 0.4 (conversacional, NO determinístico como validators 0.0). Architect razona mejor con thinking enabled (Sonnet 4-5 + thinking budget 10000).
- Storage único: VF_STORAGE_DIR (next.config override). system-log.jsonl vive en storage/. NO usar process.cwd() para rutas de storage.
- ANTHROPIC_API_KEY: único en .env raíz (next.config la sobreescribe en process.env). Si está en ROTATE_*, discussWithClaude retorna error. Verifica con curl http://localhost:3000/api/debug/env-check.
- Español neutro: conservador a propósito. NO corrige homógrafos pretérito (salí/sentí/descubrí) sin contexto. Lista VOSEO_MAP única compartida (chat + pipeline + quality-gate).


---

# Subsistema: Contratos, Presets y Marcas (Video Factory)

## Propósito

Define la arquitectura de datos compartida entre todas las partes del pipeline (generación de imágenes, animación, composición) mediante schemas Zod, y gestiona dos bibliotecas persistidas:
- **Presets**: estilos visuales + narrativos reutilizables (aprobados y en aprendizaje)
- **Marcas**: identidades de producto, voces, colores, ingredientes visuales

Permite que el pipeline automático (3 modos: CREAR / RIPEAR / APRENDER) razone con formatos, personajes y composiciones complejas de forma tipada.

---

## End-to-End: Cómo funciona

### 1. **Schemas Zod (Contratos)**

Definidos en `packages/contracts/src/` — fuente única de verdad para la estructura de datos:

#### **scene.schema.ts** (Escenas + Composición)
- `Scene` (líneas 175-243): un visual estático/animado que cubre un rango de audio. Campos clave:
  - `text`: lo que se narra durante la escena
  - `imagePrompt`: prompt usado para generar la imagen (regenerable)
  - `imagePath`, `videoPath`: outputs generados
  - `textOverlays`: capas de texto vectorial a renderizar en Remotion (producto, fecha, métrica)
  - `compositeLayout`: grid fijo (2x2, 3x2, before-after) o ausente (single)
  - `subScenes`: paneles del grid, cada uno independiente
  - **`composition`** (línea 205): array de `CompositeElement` — motor de composición LIBRE (Fase 2)
  - **`speakerId`** (línea 218): ID de hablante para multi-voz (CapCut style)
  - `speaking` (línea 214): ¿el personaje habla (lip-sync) o voice-over?
  - `editStep`: edit image-to-image opcional (ej. flujo linfático glowing sobre abdomen)
  - `componentType`: enrutado a qué provider (cgi-macro, real-ugc-human, overlay-on-body)
  - `featuresCharacter`: ¿muestra al personaje recurrente? (ancla identidad)

- `CompositeElement` (líneas 93-169): unidad del motor de composición:
  - `id`: identificador estable para ediciones/aprendizaje
  - `kind`: image | video | text | annotation
  - `rect`: posición en % del frame 9:16 (xPct, yPct, widthPct, heightPct) — GEOMETRÍA LIBRE
  - `rotationDeg`, `opacity`, `zIndex`, `fit`, `cornerRadiusPct`: propiedades de layout
  - `startSeconds`, `endSeconds`: timing relativo a la escena
  - `fadeInFrames`, `fadeOutFrames`: transiciones suaves por elemento
  - `chromaKey`: recorte por chroma (color + similarity) — usado para overlays recortados
  - `annotation`: círculos/flechas rojas sincronizadas (shape, color, fromXPct/fromYPct)
  - `manuallyAdjusted`: flag si un humano lo ajustó en el editor (para aprendizaje)

- `TextOverlay` (líneas 9-25): capa de texto vectorial:
  - `kind`: product-label | day-counter | metric-callout | subtitle-banner
  - `text`, `position`, `color`, `scale`: contenido y visual

- `CompositeLayout` (líneas 42-50): templates rígidos (grid-2x2, grid-3x2, before-after, pip, etc.)

- `SubScene` (líneas 55-74): panel dentro de un composite layout:
  - `panel`: ID de posición (top-left, bottom-wide, etc.)
  - `imagePrompt`: prompt específico, simplificado vs. grid entero
  - `imagePath`: imagen generada para este panel
  - `textOverlay`: overlay propio del panel

- `SceneTrack` (líneas 247-258): colección de escenas + metadata:
  - `narratorProfile`: perfil del narrador único (retro-compatible)
  - **`speakers`**: array de `SpeakerProfile` para multi-voz (nuevo, opcional)

---

#### **preset.schema.ts** (Estilos Reutilizables)
- `PresetConfig` (líneas 220-252): definición completa de un estilo:
  - `id`, `displayName`, `description`
  - **`category`**: narrativa (doctor_autoridad, mujer_empoderada, voiceover_impersonal, etc.)
  - **`format`**: visualización (b-roll-static, b-roll-animated, ugc-broll, ugc-testimony, vsl, voiceover-animated)
  - **`style`**: estético (pixar_3d, comic_sepia, fotorealista, ugc_real, etc.)
  - `classification`: (formato, hookAngulo, funnelStage, awareness)
  - `estrategia`: plano_fijo (1 imagen estática) | multi_escena (N escenas animadas)
  - `visualEngine`: imagen4 | veo-lite | veo-fast | veo-standard | higgsfield
  - **`visualStyle`**:
    - `promptTemplate`: prompt base prepensable a cada escena
    - `negativePrompt`: qué RECHAZAR (anti-ilustración, anti-foto, etc.)
    - **`styleBoilerplate`** (línea 45): prefix invariante y prepensable (ej. "sepia vintage animation...")
    - **`forbiddenStyleTerms`** (línea 52): términos que SIEMPRE van al negative prompt
    - **`consistentCharacter`** (línea 62): ¿anclar identidad del personaje? (Fase 2)
    - **`animationLayers`** (línea 57): config de 3 capas para animación (físico + interno + cámara)
  - `subtitles`: estilo, posición, color, autoZapcap opt-in
  - `composition`: ken-burns, background music
  - timestamps: createdAt, updatedAt

- `PresetFormatKind` (líneas 153-160): enum canónico de formatos — extensible
- `CANONICAL_FORMATS` (línea 173): catálogo de todos los formatos con descripción

---

#### **brand.schema.ts** (Identidad de Marca)
- `BrandConfig` (líneas 85-122): definición completa:
  - `products`: array de `Product` (id, name, description, **referenceImagePath**, dimensions)
    - `referenceImagePath`: imagen del producto que scene-planner y compositor pueden citar/overlay
  - **`defaultVoice`**: `ElevenLabsVoiceConfig` (voiceId, stability, similarity, style, gender, ageRange, label)
  - **`voiceLibrary`**: array de voces alternas para multi-voz (select según narratorProfile)
  - `language`, `brandColors`, `toneRules` (avoid, prefer)
  - **`ingredients`** (línea 112): `BrandIngredients` (NUEVO):
    - `logoPath`, `logoDescription`, `logoPlacement`
    - `mustInclude`: frases que SIEMPRE aparecen
    - `mustAvoid`: claims bloqueadas
    - `colorPalette`: array de {name, hex, usage}
    - `assets`: array de {id, path, kind, description} — fotos, packaging, mockups, etc.

---

#### **script.schema.ts** (Guión + Voces)
- `ParsedScript`: segmentos + duración + narratorProfile + speakers
- **`NarratorProfile`** (líneas 21-36): perfil único (retro-compatible):
  - `gender`, `ageRange`, `characterCard`, `narratorPresent`
- **`SpeakerProfile`** (líneas 44-55): hablante para multi-voz:
  - `id`, `role` (authority | user | voiceover | other)
  - `gender`, `ageRange`, `characterCard`, **`voiceId`** (referencia a brand.voiceLibrary)

---

#### **ad-analysis.schema.ts** (Análisis de Ads para Ripeo)
- `AdAnalysis` (líneas 126-169): resultado de analizar un MP4 con Gemini:
  - `fullNarration`: transcript de voz en off
  - `scenes`: array de `AdSceneAnalysis` (index, startSec/endSec, visualDescription, narrationFragment)
  - `product`: nombre, visualDescription, mainClaim, isCompetitor
  - `editorialLine`: estructura narrativa + tono
  - `hookType`: shock | curiosidad | autoridad | pain-agitation | testimonio | etc.
  - `cta`: call-to-action
  - **`visualStyleProfile`** (líneas 53-122): CRÍTICO para ripeo fiel:
    - `mediaType`: ugc-real | studio-photo | stock-medical | illustration-2d | motion-graphics | etc.
    - `lookDescription`: 30-80 palabras en inglés describiendo estética fotográfica/ilustrativa
    - `dominantPalette`: colores hex extraídos
    - `textOverlayStyle`: background, color, position, fontStyle (si hay text overlay)
    - `realCharactersDescription`: descripción de personajes reales
    - `aestheticTags`: tags libres ["TikTok urgent", "before-after format", etc.]

---

### 2. **Carga de Presets y Marcas**

#### **brand-preset-loader.ts**
```typescript
loadBrand(id) → BrandConfig        // lee packages/brands/{id}.brand.json
loadPreset(id) → PresetConfig      // busca PRESETS_DIR, fallback PENDING_PRESETS_DIR
loadAllBrands() → BrandConfig[]
loadAllPresets() → PresetConfig[]  // solo aprobados, NO pending
```

**Rutas absolutas** (desde `paths.ts`):
- `BRANDS_DIR = <root>/packages/brands`
- `PRESETS_DIR = <root>/packages/presets`
- `PENDING_PRESETS_DIR = <root>/packages/presets/pending`

---

### 3. **Ripeo: Dynamic Preset Builder**

#### **dynamic-preset-builder.ts** (líneas 1-305)

Transforma `AdAnalysis` → `PresetConfig` (aprendizaje automático).

**Flujo:**
1. **`inferCategory(analysis)`** (líneas 37-98): hookType + narratorProfile → categoría narrativa
2. **`inferFormat(analysis)`** (líneas 108-167): mediaType del visualStyleProfile → formato visual
3. **`buildVisualPromptTemplate(analysis)`** (líneas 178-220):
   - Si `visualStyleProfile` presente: usa `lookDescription` + `dominantPalette` + `aestheticTags` (NUEVO, SEÑAL FUERTE)
   - Si no: heurística sobre `visualDescription` (compat con análisis viejos)
4. **`pickVisualEngine(analysis)`** (líneas 250-273): mediaType → imagen4 (photo-real) o veo-lite (ilustración)
5. **`buildNegativePrompt(analysis)`** (líneas 279-304): media type → anti-términos específicos
6. **`buildAndPersistDynamicPreset(opts)`**: persiste el preset en `packages/presets/pending/learned-<hash>.preset.json`

**Idempotencia vía hash**: mismo AdAnalysis → mismo presetId, evita duplicados.

---

### 4. **Route Profiles: Detección de Tipo de Video**

#### **route-profiles.ts** (líneas 1-202)

Define "una ruta buena para cada tipo de video":

```typescript
interface RouteProfile {
  id: string
  anatomyMode: 'strict' | 'lenient'  // ¿tan estricto con anatomía humana?
  animation: 'real' | 'ken-burns'    // ¿image-to-video o pan/zoom estático?
  motionIntensity?: 'powerful' | 'moderate' | 'subtle'
}
```

**Perfiles predefinidos:**
1. **cartoon-3d** (match: pixar, 3d-animated, frutinovela):
   - anatomía lenient (dedos/proporciones = estilo, NO error)
   - ken-burns (sin animación real)
   - movimiento powerful

2. **illustrated** (match: watercolor, comic, sepia, ghibli):
   - anatomía lenient
   - ken-burns
   - (sin motionIntensity específica)

3. **ugc-real** (match: realista, fotorealista, smartphone):
   - anatomía **strict** (5 dedos crítico)
   - animación **real** (Higgsfield/Kling/Veo)
   - movimiento subtle

4. **DEFAULT** (fallback histórico):
   - anatomía strict
   - animación real

**`resolveRouteProfile(input)`** (líneas 174-186): match por formatId/styleId/keywords en styleBase → devuelve perfil. Si nada matchea → DEFAULT.

---

### 5. **Flujo de Marca en el Pipeline**

Cuando se crea un video:

1. El usuario elige marca (ej. Vitaly)
2. `loadBrand('vitaly')` carga `packages/brands/vitaly.brand.json`
3. El preset carga voces por defecto + voice library
4. `scene-planner` accede a `brand.ingredients` para:
   - Citar `product.referenceImagePath` en prompts ("el producto se ve como...")
   - Incluir `mustInclude` frases en el guión
   - Evitar `mustAvoid` claims
   - Usar `colorPalette` ("usa el amarillo Vitaly #FFE600")
   - Invocar `assets` en prompts ("overlay el packshot frontal")
5. `scene-animator` selecciona voz por narratorProfile:
   - Si gender=male + age 45-60: busca en voiceLibrary un match (ej. George)
   - Si no hay match: usa defaultVoice
6. El compositor puede overlay-ar logo según `logoPlacement`

---

## Archivos Clave (Evidencia)

### **Schemas (Contratos)**
- `packages/contracts/src/scene.schema.ts:175-243` — Scene + CompositeElement (lineas exactas)
- `packages/contracts/src/scene.schema.ts:93-169` — CompositeElement (geometría libre + chroma/annotation)
- `packages/contracts/src/scene.schema.ts:218` — speakerId para multi-voz
- `packages/contracts/src/preset.schema.ts:45` — styleBoilerplate
- `packages/contracts/src/preset.schema.ts:52` — forbiddenStyleTerms
- `packages/contracts/src/preset.schema.ts:62` — consistentCharacter
- `packages/contracts/src/brand.schema.ts:28` — Product.referenceImagePath
- `packages/contracts/src/brand.schema.ts:112` — BrandIngredients (logo, assets, colorPalette, mustInclude/mustAvoid)
- `packages/contracts/src/script.schema.ts:44-55` — SpeakerProfile
- `packages/contracts/src/ad-analysis.schema.ts:53-122` — AdVisualStyleProfile (mediaType, lookDescription, etc.)

### **Carga y Persistencia**
- `apps/web/lib/brand-preset-loader.ts:12-46` — loadBrand/loadPreset (busca PENDING fallback)
- `apps/web/lib/paths.ts:22-27` — BRANDS_DIR, PRESETS_DIR, PENDING_PRESETS_DIR
- `packages/presets/` — archivos `.preset.json` aprobados
- `packages/presets/pending/` — `learned-*.preset.json` aprendidos (+ .understanding.json, .iterations.json)
- `packages/brands/vitaly.brand.json` — ejemplo Vitaly (5 productos, voiceLibrary, toneRules)
- `packages/brands/biozentra.brand.json` — ejemplo NUEVO (ej. ingredientes, assets, referenceImagePath)

### **Conversión AdAnalysis → Preset**
- `apps/web/lib/dynamic-preset-builder.ts:37-98` — inferCategory
- `apps/web/lib/dynamic-preset-builder.ts:108-167` — inferFormat (usa visualStyleProfile.mediaType)
- `apps/web/lib/dynamic-preset-builder.ts:178-220` — buildVisualPromptTemplate (NEW: lookDescription)
- `apps/web/lib/dynamic-preset-builder.ts:250-304` — pickVisualEngine + buildNegativePrompt

### **Rutas por Tipo**
- `apps/web/lib/route-profiles.ts:33-54` — RouteProfile interface + PROFILES array
- `apps/web/lib/route-profiles.ts:174-186` — resolveRouteProfile (matching logic)

### **Ejemplo de Preset Aprobado**
- `packages/presets/doctor_ugc_broll_handheld.preset.json` — estructura completa

### **Ejemplo de Preset Aprendido**
- `packages/presets/pending/learned-auto-418fba61.preset.json` — incluye styleBoilerplate, forbiddenStyleTerms

---

## Estado Real (Verificado Jun-2026)

### **Vitaly (Marca Existente)**
- ID: `vitaly`
- Productos: vitaly_gotas (drenaje linfático), sumi_eso_riper (reflujo)
- Voces: defaultVoice (femenino chismosa) + voiceLibrary (George autoritativo, Daniel cálido, David energético)
- toneRules: "tono amiga chismosa por WhatsApp", evita voseo argentino
- SIN ingredientes (vintage, anterior a nueva API)

### **BioZentra (Marca Nueva — Reciente)**
- ID: `biozentra`
- Productos: `biozentra_ceylon` con `referenceImagePath` y `dimensions` detalladas
- Voces: defaultVoice (femenino neutro) + voiceLibrary (alternos)
- **Ingredientes NUEVOS**: logoDescription, mustAvoid (voseo), colorPalette (marrón canela + dorado MCT), assets (packshot-frontal)
- toneRules: "español neutro con tú", "tono dramático VSL"

### **Presets**
- **Aprobados** (~16): doctor_*, mujer_*, educativo_*, testimonio_*, voiceover_*, learned-auto-60a76004.preset.json (muy grande, 116KB)
- **Aprendidos/Pendientes** (~8): learned-auto-418fba61, learned-vitaly-media-23faa1f, learned-biozentra-tramo-metformina (73KB)

---

## Wirings No-Obvios

1. **Búsqueda de Presets: APPROVED + FALLBACK PENDING**
   - `loadPreset(id)` revisa `PRESETS_DIR` primero, luego `PENDING_PRESETS_DIR` (línea 30-37, brand-preset-loader.ts)
   - Permite usar presets aprendidos INMEDIATAMENTE después de ripear (antes de admin approval)

2. **visualStyleProfile: Clave para Ripeo Fiel**
   - Si `AdAnalysis.visualStyleProfile` está (NUEVO desde jun-2026), es la **SEÑAL FUERTE** para `buildVisualPromptTemplate`
   - Sin esto, cae a heurística regex (compat, pero fragil)
   - El `lookDescription` (30-80 palabras, inglés) es lo que SALVA el ripeo: evita forzar ilustración a un UGC real

3. **Ingredientes: No Requeridos**
   - `BrandIngredients` es default vacío (mustInclude: [], mustAvoid: [], etc.)
   - Retrocompatible: Vitaly NO tiene ingredientes poblados, BioZentra SÍ
   - scene-planner y compositor verifican `if (brand.ingredients.assets?.length > 0)` antes de usarlos

4. **speakerId + SpeakerProfile: Multi-voz Pero Retro-compatible**
   - Si Scene tiene `speakerId`, TTS busca `SceneTrack.speakers[]` por ID
   - Si no hay speakers[], usa `narratorProfile` único (viejo flujo)
   - El pipeline generador aún NO emite multi-voz (Fase 2 pendiente): lo hace manual/Copilot

5. **Route Profiles: Resolver Antes de Generar**
   - `resolveRouteProfile(styleBase, formatId, styleId)` debe llamarse **ANTES** de scene-validator
   - Determina si la anatomía es `strict` (humanos reales) o `lenient` (cartoon, ilustración)
   - El validator rechaza distinto cosas según el perfil (no todos ven el 6-dedo igual)

6. **compositeLayout vs. composition: Dos Modos**
   - `compositeLayout`: templates rígidos (grid-2x2, pip, before-after)
   - `composition`: array libre de `CompositeElement` (lo que el editor manipula + aprendizaje registra)
   - **NUNCA ambos poblados simultáneamente** — la escena elige modo
   - Si `composition.length > 0`, el compositor renderiza con `FreeformComposite` (Remotion)
   - Si vacío y `compositeLayout != 'single'`, renderiza el grid templado

---

## Gotchas (Cosas a No Redescubrir)

1. **styleBoilerplate vs. promptTemplate**
   - `styleBoilerplate` es un **PREFIX** que se PREPENSA a `promptTemplate` por escena (opcional, aditivo)
   - `promptTemplate` es el template COMPLETO de base
   - Diferencia: boilerplate es "siempre esto al inicio"; template es "el todo"
   - Si están ambos, scene-planner hace `boilerplate + " " + promptTemplate` antes de mandar a generador

2. **forbiddenStyleTerms ≠ negativePrompt**
   - `forbiddenStyleTerms`: lista que el scene-planner SUMA al `negativePrompt` por escena (ej. ["illustration", "cartoon"])
   - `negativePrompt`: template base ya con rechazos genéricos (low quality, watermark, etc.)
   - Usar forbiddenStyleTerms para garantizar que los TÉRMINOS nunca aparezcan sin duplicarlos manualmente en cada prompt

3. **BrandIngredients NO está en Vitaly, SÍ en BioZentra**
   - Si el código asume `brand.ingredients` siempre poblado, falla en Vitaly
   - Verificar siempre `brand.ingredients?.assets?.length > 0` antes de iterate
   - O pedir a owner que llene Vitaly.ingredients si quiere usarla

4. **pending/learned-*.json: Hay 3 Files, No 1**
   - Un preset aprendido genera:
     - `learned-<id>.preset.json` — el config del preset
     - `learned-<id>.understanding.json` — análisis multimodal del original
     - `learned-<id>.iterations.json` — historial de refinamientos (opcional)
   - Todos están en `PENDING_PRESETS_DIR`
   - Solo el `.preset.json` se carga en `loadPreset()`

5. **AdVisualStyleProfile.mediaType es la Decisión más Importante**
   - Determina engine (imagen4 vs. veo), negative prompt específico, styleBoilerplate
   - Sin `visualStyleProfile` (análisis viejos), cae a heurística regex débil
   - Si agregás ad-analyzer NUEVO que genere visualStyleProfile, automáticamente ripeos son 10x mejores

6. **speakerId pero Sin speakers[]**
   - Si una `Scene` tiene `speakerId` pero `SceneTrack.speakers` está vacío, TTS falla (o usa default)
   - Verificar coherencia: si hay speakerId, DEBE haber speakers[] con ese ID
   - Retro-compatible: si speakerId es null, todo usa narratorProfile

7. **routeProfile Afecta MÚLTIPLES Validadores**
   - Anatomía: strict vs. lenient (dedos, proporciones)
   - Animation: real vs. ken-burns (qué tan estricto con movimiento)
   - Motion intensity: used by scene-animator para variar intensidad de prompt
   - Cambiar un profile = cambiar comportamiento de TODO el pipeline para ese estilo

8. **PENDING_PRESETS_DIR es SUBCARPETA de PRESETS_DIR**
   - `PENDING = PRESETS_DIR + '/pending'`
   - `loadAllPresets()` NO trae pending (solo approved)
   - Si quieres listar todos incluyendo aprendidos, usa `loadAllPendingPresets()` (admin-presets-store.ts)

9. **Español Neutro en styleBoilerplate / promptTemplate**
   - Si el prompt original dice "acá" o voseo, DEBE normalizarse a español neutro
   - `toNeutralSpanish(text)` (apps/web/lib/neutral-es.ts) normaliza antes de generar
   - Los prompts a image generators SIEMPRE en inglés (promptTemplate es en inglés)
   - Los prompts a TTS/scene-planner SÍ en español (y DEBE ser neutro)

10. **product.referenceImagePath: Path Absoluto ACTUAL en Disk**
    - No es URL remota, es ruta local absoluta (`C:/Users/cmktc/...`)
    - Scene-planner lo cita en prompts como instrucción de referencia image-to-image
    - Compositor lo puede overlay-ar si lo necesita
    - Verificar que el archivo exista antes de usarlo (error handling importante)

---

## Lectura Recomendada para Nuevo Claude

1. Empezar por `packages/contracts/src/scene.schema.ts` — entender `CompositeElement` y los 3 modos de composición (single, layout template, freeform)
2. Luego `preset.schema.ts` — taxonomía de cascada (categoría → formato → estilo)
3. Luego `brand.schema.ts` — especialmente `BrandIngredients` (NUEVO)
4. Luego `ad-analysis.schema.ts` — `AdVisualStyleProfile` (SEÑAL para ripeo fiel)
5. Revisar ejemplos: `packages/presets/doctor_ugc_broll_handheld.preset.json` + `learned-auto-418fba61.preset.json`
6. Leer `route-profiles.ts` completo — detecta qué tipo de video es y adapta validación/animación
7. Revisar `CLAUDE.md` invariantes (#2, #3, #5 sobre capacidad vs. autonomía, lipsync, animación de personas)

**⚠️ Gotchas (12-contratos-presets-brands):**
- styleBoilerplate es PREFIX que se prepensa a promptTemplate (aditivo), NO reemplazo
- forbiddenStyleTerms es lista que se SUMA a negativePrompt por escena, evita duplicar términos manuales
- loadPreset busca PENDING_PRESETS_DIR si no encuentra en PRESETS_DIR (permite usar aprendidos antes de aprobación)
- visualStyleProfile.mediaType es SEÑAL FUERTE para ripeo — sin ella, cae a heurística regex débil
- BrandIngredients es opcional/default vacío — Vitaly NO lo tiene, BioZentra SÍ (verificar antes de asumir)
- speakerId sin speakers[] causa falla en TTS — verificar coherencia siempre
- pending/ es SUBCARPETA de presets/ — loadAllPresets() NO trae pending (solo loadAllPendingPresets en admin)
- routeProfile afecta MÚLTIPLES validadores (anatomía, animación, motion intensity) — no tocar sin entender cascada completa
- product.referenceImagePath es path ABSOLUTO local, NO URL — verificar que exista antes de usar
- compositeLayout vs composition: NUNCA ambos poblados simultáneamente — la escena elige un modo


---

# Subsistema 13: App/UI & Seguridad — Documentación de Referencia

## Descripción del área

El subsistema **app/ui-seguridad** cubre la capa web de Video Factory: autenticación, autorización, protección de rutas (middleware), y los endpoints/páginas públicas y protegidas que el operador (owner) usa para crear, editar, supervisar y mejorar videos.

**Alcance:** 
- `apps/web/middleware.ts` — gate de autenticación a nivel de request
- `apps/web/lib/auth.ts` — lógica de cookies, password checking, admin authorization
- `apps/web/app/page.tsx` — login público
- `apps/web/app/(app)/**` — todas las páginas protegidas (create, rip, aprendizaje, runs, admin, brands)
- `apps/web/app/api/**` — endpoints protegidos y públicos (auth, runs/[id]/*.ts, admin/*, brands/*, generate, etc.)
- Auto-recovery de runs zombie en `GET /api/runs/[id]`
- Quality gate & repair endpoints: `/api/runs/[id]/gate`, `/api/runs/[id]/gate/repair`

---

## Flujo de autenticación end-to-end

### 1. Login público → Cookie de app (`page.tsx` + `/api/auth`)

**Usuario sin autenticar:**
- Navega a `/` → ve `apps/web/app/page.tsx` (LoginPage)
- Formulario pide `password` (APP_PASSWORD del .env)
- POST → `/api/auth` con `{ password }`

**Validación en `/api/auth` (`apps/web/app/api/auth/route.ts:1-21`):**
```
- checkPassword(submitted) compara contra process.env['APP_PASSWORD'] (===, no timing-safe)
- Si correcto → setAuthCookie() setea cookie 'app_auth'='valid' (httpOnly, sameSite:strict, 30 días)
- POST devuelve { ok: true } → router.push('/create')
```

**Resultado:** Usuario tiene cookie `app_auth=valid`, puede acceder a rutas en `/(app)/`.

---

### 2. Middleware protection (`middleware.ts:1-48`)

**Matcher protegido:**
```typescript
config.matcher = [
  '/create/:path*',    // /create, /create/*, etc. → requieren app_auth
  '/runs/:path*',      // /runs, /runs/[id], /runs/[id]/build, etc.
  '/rip/:path*',       // /rip, /rip/[id]
  '/admin/:path*',     // /admin (página cliente)
  '/aprendizaje/:path*',
  '/api/admin/:path*', // Todos los endpoints de admin
]
```

**Flujo en `middleware()` (middleware.ts:4-33):**
1. **Admin API gate (línea 9-13):** Si `path.startsWith('/api/admin')` AND no es `/api/admin/login`:
   - Comprueba `req.cookies.get(ADMIN_COOKIE)?.value !== ADMIN_COOKIE_VALUE`
   - Si falta → `401 Requiere acceso de admin`
   - Excepción: `/api/admin/login` (chicken-and-egg: NO puede exigir la cookie que él crea)

2. **App auth check (línea 16-21):** Para el resto (todas las rutas del matcher):
   - Comprueba `req.cookies.get(AUTH_COOKIE)?.value !== AUTH_COOKIE_VALUE`
   - Si falta → redirige a `/` (login)

3. **Cache headers en dev (línea 27-31):** Si `NODE_ENV !== 'production'`:
   - Setea `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`
   - Razón: después de cambios de código, force-refresh sin Ctrl+F5

**Nota importante:** `/brands` SÍ está dentro de `/(app)` pero el middleware NO tiene un matcher explícito para `/brands/:path*`. Sin embargo, como `/brands` está bajo el layout `app/(app)/`, está protegido implícitamente porque el middleware cubre `/api/` pero las **páginas client-side sí pasan por middleware** vía `/(app)` layout. **(Ver gotcha #2.)**

---

### 3. Admin access (`/admin` + `/api/admin/login`)

**Requisito:** El usuario ya tiene `app_auth=valid` (logueado a la app).

**Flujo:**
1. Navega a `/admin` → **página verificada en `apps/web/app/(app)/admin/page.tsx:1-32`:**
   - Si `isAdmin()` = false (sin cookie `admin_auth`) → muestra `<AdminLogin>` (AdminLogin.tsx)
   - Si `isAdmin()` = true → muestra `<AdminPanel>` (acceso completo)

2. **Admin login form (AdminLogin.tsx:15-86):**
   - Pide `password` (ADMIN_PASSWORD del .env)
   - POST → `/api/admin/login` con `{ password }`

3. **Validación en `/api/admin/login` (apps/web/app/api/admin/login/route.ts:1-43):**
   - Primero verifica `isAuthenticated()` (app_auth válida) — línea 18
   - Luego verifica `isAdminConfigured()` (ADMIN_PASSWORD existe) — línea 21
   - `checkAdminPassword(submitted)` compara contra process.env['ADMIN_PASSWORD'] (===, no timing-safe) — línea 36
   - Si correcto → `setAdminCookie()` setea `admin_auth=valid` (httpOnly, sameSite:strict, **8 horas**, más corto que app_auth)

**Resultado:** Usuario tiene AMBAS cookies: `app_auth=valid` + `admin_auth=valid`, puede usar `/admin` y `/api/admin/*.

---

## Endpoints clave protegidos

### Runs API (`/api/runs/[id]/*`)

**Todos requieren `isAuthenticated()` al inicio:**

| Endpoint | Método | Función |
|----------|--------|---------|
| `/api/runs` | GET | Listar runs (brand/product/status filters) |
| `/api/runs/[id]` | GET | **Auto-zombie detection** (ver sección 4) |
| `/api/runs/[id]/intervene` | POST/GET | Owner feedback live (approve/reject/comment) |
| `/api/runs/[id]/collaborative-state` | GET | Estado pausa modo colaborativo |
| `/api/runs/[id]/composition` | GET/PUT | Leer/editar scene-plan.json (editor manual) |
| `/api/runs/[id]/corrections` | POST | Fork + aplicar corrección dirigida |
| `/api/runs/[id]/gate` | GET | Leer quality gate report + repairs planificadas |
| `/api/runs/[id]/gate/repair` | POST | **Ejecutar reparación (brazo) con OK del owner** |
| `/api/runs/[id]/rerender` | POST | Re-render con composición editada |

**Ejemplo de auth check en `/api/runs/[id]/intervene` (apps/web/app/api/runs/[id]/intervene/route.ts:59-62):**
```typescript
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  // ... resto de lógica
}
```

### Generation & Upload (`/api/generate`, `/api/rip/upload`, etc.)

Todos requieren `isAuthenticated()`:
- `POST /api/generate` — inicia pipeline (crea run nuevo)
- `POST /api/rip/[id]/rip` — inicia rip
- `POST /api/training/[id]/learn` — inicia aprendizaje
- `POST /api/rip/upload` — upload de video a ripear (FormData)

### Admin-only endpoints (`/api/admin/*`)

**Protección en DOS niveles:**

1. **Middleware (middleware.ts:9-13):** Rechaza si falta `admin_auth` cookie antes de entrar
2. **Función handler:** Algunas verifican `isAuthenticated()` extra (defensa en profundidad)

Ejemplos:
- `GET /api/admin/kb` — listar KB (authenticado)
- `POST /api/admin/presets/[id]/approve` — aprobar preset (authenticado)
- `POST /api/admin/prompt-patches` — detectar patrones (authenticado, puede escalar a admin-only en futuro)

**Todos menos `/api/admin/login` requieren `admin_auth` cookie por middleware.**

### Public/Unauthenticated endpoints

**Explícitamente PÚBLICOS (sin auth):**
- `GET /api/onboarding/status` — checklist de setup (solo presencia booleana, nunca expone valores)
- `GET /` → redirect to `/login` si no autenticado (o muestra LoginPage)
- `GET /onboarding` → setup inicial (diseño pre-auth)

---

## Auto-recovery de runs zombie

**Endpoint:** `GET /api/runs/[id]` (apps/web/app/api/runs/[id]/route.ts:30-137)

**Problema:** Si el dev server cae a mitad de un pipeline, el row en DB queda con `status='running'` para siempre — el proceso Node murió sin poder marcar failed. UI muestra "running 69%" indefinidamente.

**Solución (auto-detectado al pollear):**

1. **Condiciones para marcar zombie (línea 46-52):**
   - `run.status === 'running'` AND
   - NO `awaitingApproval` (runs colaborativos pausados esperando owner NO son zombies) AND
   - `startedAt` existe AND
   - `Date.now() - startedAt > ZOMBIE_THRESHOLD_MS` (90 minutos por defecto, línea 25)

2. **Doble-check contra falso positivo (línea 54-79):**
   - Lee el `workDir` del run, busca el archivo editado más recientemente (`mtime`)
   - Si última escritura < 5 min atrás → pipeline está ACTIVO, NO es zombie
   - Si última escritura > 5 min atrás O sin workDir → es zombie

3. **Auto-reparación (línea 81-117):**
   - Marca el run como `status='failed'` en DB
   - Setea `errorMessage` explicativo ("Run auto-marcado FAILED por inactividad...")
   - Loguea evento a `system-log.ts` con `kind:'run-failed', data:{triggerSource:'auto-zombie-detection'}`
   - El usuario ve el botón "Reintentar" o puede "Forkear" desde la última escena buena

**Thresholds:**
- `ZOMBIE_THRESHOLD_MS = 90 * 60 * 1000` — runs legítimos tardan 5-60 min típicamente; 90 min cubre worst-case (rips de alta fidelidad ~52 escenas)
- `STALE_WORKDIR_THRESHOLD_MS = 5 * 60 * 1000` — si el workDir se escribe activamente, el pipeline está vivo

---

## Quality Gate & Repair ("Mostrar" + "Aplicar")

### 1. Mostrar: `/api/runs/[id]/gate` (GET)

**Función:** Devuelve el reporte del quality gate persistido en KB (scope `gate:<runId>`) + repairs planificadas.

**Implementación (apps/web/app/api/runs/[id]/gate/route.ts:26-51):**
```typescript
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) { /* 401 */ }
  
  const run = db.select().from(runs).where(eq(runs.id, params.id))[0];
  if (!run) { /* 404 */ }
  
  // Leer reporte persistido (best-effort, null si no existe aún)
  let qualityGate: QualityGateReport | null = null;
  try {
    qualityGate = await readQualityGateReport(`gate:${params.id}`);
  } catch { qualityGate = null; }
  
  // Fase 2: deriving reparaciones desde el reporte (no del cliente)
  const repairs = qualityGate ? planRepairs(qualityGate) : [];
  
  return NextResponse.json({ qualityGate, repairs });
}
```

**Datos devueltos:**
- `qualityGate.veredicto` — "pass" | "revisar" | "fail"
- `qualityGate.bloqueantes[]` — problemas críticos (dimension, severidad, fixPropuesto)
- `qualityGate.recomendaciones[]` — sugerencias sin bloqueo
- `repairs[]` — acciones ejecutables derivadas (regenerate-image, reanimate, escalate, etc.)

**UI (GateFindings.tsx:191-289):** Renderiza hallazgos como cards, botón "Auto-reparar" para acciones ejecutables.

---

### 2. Aplicar: `/api/runs/[id]/gate/repair` (POST)

**Función:** Ejecuta la reparación de un bloqueante CON OK del owner (nada se auto-aplica).

**Implementación (apps/web/app/api/runs/[id]/gate/repair/route.ts:19-81):**
```typescript
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) { /* 401 */ }
  
  // Body: { blockerIndex: number }
  const body = await req.json() as { blockerIndex?: number };
  const idx = body.blockerIndex; // validar es int ≥0
  
  // RE-DERIVAR repair desde reporte persistido (no confiar en cliente)
  const gate = await readQualityGateReport(`gate:${runId}`);
  const repairs = planRepairs(gate);
  const repair = repairs[idx]; // fetch desde servidor, no desde cliente
  
  // Ejecutar reparación (forkea run, regenera escena)
  const outcome = await executeGateRepair({ originalRunId: runId, repair });
  if (!outcome.ok) { /* 409 */ }
  
  // Loguea evento
  logSystemEvent({
    kind: 'scene-regenerated',
    data: { runId, newRunId: outcome.newRunId, sceneIndex: repair.sceneIndex, ... }
  });
  
  return NextResponse.json({ ok: true, newRunId: outcome.newRunId, ... });
}
```

**Seguridad clave:** El servidor RE-DERIVA la reparación desde el reporte persistido, no confía en los datos del cliente. Así se evita que alguien hackee el índice y genere reparaciones arbitrarias.

---

## Colaboración en vivo ("Interviene")

### `/api/runs/[id]/intervene` (POST/GET)

**Propósito:** Owner co-piloto durante un rip; puede aprobar/rechazar/comentar scenes mientras VALIDATOR corre.

**POST (intervene/route.ts:59-136):** Acepta intervención
```typescript
{
  type: "approve" | "reject" | "comment" | "skip" | "redirect-attention",
  sceneIndex: number | null,
  category?: "style" | "anatomy" | ...,
  comment?: string,
  newImagePrompt?: string,
  newMotionPrompt?: string
}
```

**Validaciones (línea 99-110):**
- Run debe estar en `status='running' || 'pending'` Y `mode='collaborative'`
- Si `type='reject'`: requiere `newImagePrompt` o `comment` explicando el problema
- Si `type='comment'`: requiere el campo `comment`

**GET:** Devuelve historial completo de intervenciones (procesadas + pendientes)

**Guarding:** Las intervenciones SOLO se procesan si el run está en co-creación activa (v3.3 fix línea 99-110). Previene que intervenciones fantasma de un run fallido se apliquen a su fork.

---

## Editor manual de composición

### `/api/runs/[id]/composition` (GET/PUT)

**GET:** Devuelve `scene-plan.json` (sceneTrack) — lista de escenas con su composición (CompositeElement[])

**PUT:** Recibe nueva composición editada por el usuario
```typescript
{
  sceneIndex: number,
  composition: CompositeElement[]
}
```

**Flujo (composition/route.ts:83-209):**
1. Valida sceneIndex existe en scene-plan.json
2. Reescribe `composition` del escena objetivo
3. **Loop de aprendizaje (línea 149-201):**
   - Lee render-job.json (immutable, lo que la IA propuso)
   - Compara `aiComposition` vs usuario's `composition`
   - Si hay diferencias → `diffComposition()` + `recordCompositionCorrection()`
   - Persiste en `storage/composition-corrections.jsonl` (few-shot para geometry detector)

**Seguridad:** Valida existencia del run, scene-plan.json bien formado, y que sceneIndex sea válido.

---

## Correcciones dirigidas

### `/api/runs/[id]/corrections` (POST)

**Propósito:** Owner dice "este video necesita un fix" → fork del run + aplica corrección.

**Flujo (corrections/route.ts:22-122):**
1. Valida run original está `status='completed'`
2. Lee `message` (FormData, ≥5 chars) + asset opcional (image/video, ≤50MB)
3. Crea nuevo run con `originalRunId` → trazabilidad (repositorio muestra "Corrección de #abc123")
4. Lanza `applyCorrection()` en background
5. Devuelve `{ correctionId, newRunId }`

**Asset handling (línea 64-85):**
- Valida MIME: `image/png`, `image/jpeg`, `image/webp`, `video/mp4` OK
- Guarda en `newWorkDir/correction-asset.{ext}`
- Marca `uploadedAssetIsVideo` si es mp4

---

## Páginas protegidas bajo `/(app)`

**Layout (apps/web/app/(app)/layout.tsx:1-15):**
- Renderiza `<Sidebar>` con admin flag (`isAdmin()`)
- `<CopilotWidget>` accesible en todas

**Páginas:**

| Ruta | Componente | Qué hace |
|------|-----------|----------|
| `/create` | CreateForm | Inicia pipeline (mode='auto' o 'collaborative') |
| `/rip` | RipUploader | Sube video a ripear |
| `/rip/[id]` | RipDetailView | Detalle del rip (imágenes propuestas, keyframes) |
| `/aprendizaje` | TrainingRepository | Sube videos para aprender formato |
| `/aprendizaje/[id]` | TrainingDetailView | Detalle del aprendizaje |
| `/runs` | RepositoryView | Lista de runs (filtros por brand/product/status) |
| `/runs/[id]` | RunViewer | **Visualizador de video + gate findings** |
| `/runs/[id]/build` | BuildCollaborative | Modo colaborativo (pausa scene-a-scene) |
| `/runs/[id]/live` | LiveCoPilot | Supervisor en vivo (VALIDATOR chat IA) |
| `/runs/[id]/editor` | CompositionEditor | Editor manual de composición (scene-plan.json) |
| `/runs/trash` | TrashView | Runs marcados para trash |
| `/brands` | BrandsPage | Marca (logo, productos, colores) |
| `/brands/new` | CreateBrandForm | Crear marca |
| `/brands/[id]` | IngredientsEditor | Editar logo, colores, paleta, assets |
| `/admin` | AdminPanel o AdminLogin | **Panel de control (admin-only)** |
| `/sugerencias` | — | Chat con Claude |
| `/arquitecto` | — | (Placeholder) |

**Todas requieren `app_auth=valid` cookie por middleware.**

---

## Gotchas y trampas a no re-descubrir

### 1. **Password comparison NO es timing-safe**
- `checkPassword()` y `checkAdminPassword()` usan `submitted === expected` (línea 11, 50 en auth.ts)
- NO usan `crypto.timingSafeEqual()` — vulnerable a timing attacks si alguien mide duración de POST
- **Mitigation fallido:** La latencia de red típicamente domina, pero para hardening máximo se debería usar `crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))`
- **Realidad:** Es herramienta interna, single-user, no expuesta públicamente; risk bajo pero mencionable

### 2. **/brands NO está en matcher middleware explícitamente**
- `middleware.ts` config.matcher cubre `/create`, `/runs`, `/rip`, `/admin`, `/aprendizaje`, `/api/admin`
- NO menciona `/brands`
- **¿Cómo está protegido?** El layout `/(app)` está bajo Middleware, así que aunque no haya matcher explícito, Next.js aplica el middleware a TODAS las rutas bajo `/(app)` durante SSR. Las páginas ClientComponent (`'use client'`) que dependen de datos protegidos TAMBIÉN verifican `isAuthenticated()` en sus handlers de fetch (ej. fetch a `/api/brands` que requiere auth). **Pero técnicamente una ruta estática podría servirse sin pasar por middleware.** Mejor práctica: agregar `/brands/:path*` al matcher explícitamente.

### 3. **Admin auth caduca en 8 horas, app auth en 30 días**
- `setAdminCookie()` → `maxAge: 60 * 60 * 8` (8 horas, línea 58 auth.ts)
- `setAuthCookie()` → `maxAge: 60 * 60 * 24 * 30` (30 días, línea 19 auth.ts)
- **Implicación:** Si owner navega a `/admin` después de 8 horas, la cookie expira → se muestra login de admin de nuevo, pero sigue en la app
- Mensajes en AdminLogin.tsx línea 74-76 no dicen explícitamente cuánto durá (mención "aparte" es toda la info)

### 4. **El .env raíz SOBREESCRIBE siempre process.env**
- `next.config.mjs` línea 36: `process.env[key] = value` sin `if (!(key in process.env))`
- **Cambio 25-may-2026:** Antes era fallback-only, causaba valores stale (ej. ANTHROPIC_API_KEY) — rompía judge IA
- **Ahora:** El .env raíz es la única fuente de verdad
- **Gotcha:** Si alguien recrea un .env local en apps/web, lo ignora y usa el raíz. Comportamiento correcto pero opuesto a expectativa Next.js estándar

### 5. **Intervenciones son best-effort para aprendizaje**
- Cuando owner aprueba/rechaza una scene, `recordIntervention()` persiste en `storage/owner-feedback/interventions.jsonl`
- El pipeline consume estas intervenciones en el turno siguiente
- **Si el run termina o cambia de status:** Intervenciones fantasma pueden quedar pendientes. Fix v3.3 (línea 99-110) rechaza intervenciones si run no está en `running` + `collaborative`

### 6. **Zombie detection usa mtime, no timestamps de log**
- Verifica `workDir.mtime` (última escritura del directorio) via `stat()`
- NO depende de logs o heartbeats
- **Falsos positivos posibles si:** Un run se queda esperando I/O (red lenta, Gemini API timeout), el workDir no se toca pero el proceso sigue vivo en memory
- **Mitigation:** Threshold alto (90 min cubre worst-case razonable), double-check en cada GET

### 7. **Admin gates en middleware Y en handlers es redundancia defensiva**
- Middleware rechaza `/api/admin/*` si falta `admin_auth` cookie (línea 9-13)
- Algunos handlers verifican `isAuthenticated()` extra (defensa en profundidad)
- No es duplicación boba: middleware es perimeter, handlers son defensa específica. Si middleware falla (bug future), handlers aún protegen

### 8. **`/api/onboarding/status` es PÚBLICO a propósito**
- Devuelve solo presencia booleana de keys (nunca valores)
- Diseño: checklist pre-auth, el usuario NO puede hacer nada sin completar setup, así que no expone info sensible
- Es una excepción consciente, no una brecha

### 9. **Errores de login NO exponen si usuario existe o password es incorrecto**
- `/api/auth` devuelve `{ error: 'Contraseña incorrecta' }` ambos casos (línea 13 route.ts)
- `/api/admin/login` similar (línea 37 route.ts)
- Correcto: no enumera usuarios

### 10. **RunViewer poll con XHR en vez de fetch**
- RunViewer.tsx línea 57-76 define `getViaXhr()` custom wrapper
- Razón: esquiva extensiones Chrome (frame_ant hoklmmgfnpapgjgcpechhaamimifchmp) que interceptan window.fetch
- Funcionalidad robusta contra navegador hostil, no security bypass

---

## Flujos de autorización por rol/contexto

| Acción | Admin | Owner (app_auth) | Público |
|--------|-------|------------------|---------|
| Ver /create | ✓ | ✓ | ✗ → /login |
| Ver /runs | ✓ | ✓ | ✗ |
| Ver /admin | ✓ (admin_auth) | ✗ → AdminLogin | ✗ |
| POST /api/generate | ✓ | ✓ | ✗ |
| POST /api/runs/[id]/intervene | ✓ | ✓ | ✗ |
| POST /api/runs/[id]/gate/repair | ✓ | ✓ | ✗ |
| POST /api/admin/presets/[id]/approve | ✓ (admin_auth) | ✗ | ✗ |
| GET /api/onboarding/status | ✓ | ✓ | ✓ (bool only) |

---

## Variables de entorno críticas

| Var | Fuente | Usado para | Default |
|-----|--------|-----------|---------|
| `APP_PASSWORD` | .env raíz | Validar login en `/api/auth` | (requerida) |
| `ADMIN_PASSWORD` | .env raíz | Validar login admin en `/api/admin/login` | (opcional, null = admin deshabilitado) |
| `VF_STORAGE_DIR` | next.config.mjs | Raíz para KB, storage, runs | `<root>/storage` |
| `NODE_ENV` | Node/build | Aplicar no-cache headers en dev | 'development' o 'production' |

---

## Arquitectura de seguridad — Principios

1. **Single password → Single user** — Video Factory es herramienta interna. Una contraseña APP_PASSWORD = un owner usando simultáneamente. No hay usuarios múltiples, roles granulares, ni SSO.

2. **Two-tier auth (app + admin)** — Owner accede a /create, /runs, /edit con APP_PASSWORD. Panel admin (/admin) requiere ADMIN_PASSWORD separada (puede ser mismo valor pero conceptualmente aparte). Así, si alguien se clona el password del owner, no accede automáticamente a calibración del sistema.

3. **Cookies httpOnly + sameSite:strict** — Mitiga XSS (JS no puede leer) y CSRF (no se envían cross-site). Duración apropiada: 30 días app, 8 horas admin.

4. **Middleware vs Handlers** — Middleware rechaza 401 temprano; handlers verifican de nuevo (defensa en profundidad). Si middleware falla, handlers aún protegen.

5. **No auto-apply** — Reparaciones, presets aprobados, prompts patchados: TODOS requieren OK explícito del owner (POST con acción). El sistema propone; owner decide.

6. **Re-derivar en servidor** — Endpoints críticos (gate/repair, intervene) re-derivan la acción desde datos persistidos, no confían en cliente. Previene inyección de índices arbitrarios.

---

## Testing & verification

**Sin tests unitarios de auth encontrados en el código actual** (repo es small, single-user, enforcement vía code review).

Para hardening:
- Verificar que `/brands` tenga explícitamente `/brands/:path*` en middleware.matcher
- Reemplazar `===` con `crypto.timingSafeEqual()` en auth.ts lineas 11 y 50
- Agregar rate limiting a `/api/auth` y `/api/admin/login` contra brute force
- Tests E2E de flujos: login → generate → view run → intervene → admin → logout

**⚠️ Gotchas (13-app-ui-seguridad):**
- Password comparison (checkPassword/checkAdminPassword) usa === no timing-safe — vulnerable a timing attacks; crypto.timingSafeEqual() sería hardening
- /brands NO está explícitamente en middleware.matcher (/brands/:path*) — confía en (app) layout SSR pero mejor ser explícito
- Admin cookie caduca 8 horas (vs app 30 días) — expected pero no documentado en UI, owner puede perder access sin aviso
- .env raíz SOBREESCRIBE siempre process.env vía next.config.mjs (25-may-2026 fix) — cualquier .env local ignorado, comportamiento opuesto a Next.js estándar
- Intervenciones owner son best-effort para aprendizaje — si run termina, intervenciones pendientes quedan fantasma (v3.3 fix: rechaza si run no en running+collaborative)
- Zombie detection usa workDir.mtime, no heartbeats — falsos positivos posibles si proceso queda esperando I/O pero workDir no se toca
- Middleware + handlers ambos verifican auth (redundancia defensiva) — perimeter + specific, no duplicación boba
- /api/onboarding/status es PUBLIC por diseño (pre-auth setup) — expone solo presencia booleana, no valores (exception consciente)
- Errores login no distinguen usuario vs password — correcto (no enumera), pero ambos devuelven 'Contraseña incorrecta'
- RunViewer poll con XHR custom, no fetch — esquiva extensiones Chrome que interceptan fetch, robustez contra navegador hostil


---

# Subsistema 14: Infraestructura, Base de Datos y Configuración del Entorno

## Propósito

Este subsistema centraliza la configuración del entorno, la inicialización de la base de datos SQLite vía libsql/Drizzle, el almacenamiento unificado en disco, y el seguimiento de costos por ejecución de pipeline. Es el cimiento que asegura que todo el monorepo lea del **mismo .env raíz** y que toda la memoria (runs, ripeos, aprendizaje) viva en una sola carpeta.

## Arquitectura End-to-End

### 1. Carga del Entorno: `.env` raíz como fuente única de verdad

**Archivo clave:** `next.config.mjs:5-45` (apps/web/next.config.mjs)

**Comportamiento (25-may-2026 onwards):**
- Next.js ejecuta `next.config.mjs` al arrancar (dev/build/start).
- El loader manual en líneas 19-45 **SOBREESCRIBE SIEMPRE** `process.env` desde `<repoRoot>/.env` (calculado como `resolve(__dirname, '../../.env')`).
- **Cambio crítico (25-may-2026):** Antes hacía `if (!(key in process.env))` (fallback only), dejando valores stale/vacíos de arranques previos → quebrantaba el judge IA y el editor IA (ANTHROPIC_API_KEY quedaba vacía). **Ahora**: línea 37 `process.env[key] = value` — **OVERRIDE siempre**.
- Imprime en consola: `[next.config] cargadas N vars desde <path>:` + lista de keys con longitudes.
- Además establece **line 50** `process.env.VF_STORAGE_DIR = resolve(__dirname, '..', '..', 'storage')` — centraliza el almacenamiento.

**Invariante:** El `.env` raíz (C:\Users\cmktc\proyectos\video-factory\.env) es la **única fuente de verdad**. Todo lo que vive en `process.env.*` proviene de allí, no de variables de sistema, no de `.env.local`, no de nada más.

### 2. Resolución de Rutas y Almacenamiento Unificado

**Archivo clave:** `apps/web/lib/paths.ts:1-64`

**Función `findRepoRoot()`** (líneas 9-18):
- Busca `pnpm-workspace.yaml` subiendo desde `process.cwd()` hasta 8 niveles.
- Fallback: `resolve(process.cwd(), '..', '..')` (histórico: asume cwd=apps/web).
- **Problema anterior (split-brain):** Si un script se invocaba desde la raíz o desde un paquete, el cwd sería distinto → rutas de storage se partían (ej. C:\Users\cmktc\storage vs <repoRoot>\storage). **Solución:** Buscar el marcador pnpm-workspace.yaml para garantizar que siempre encontramos la raíz verdadera.

**Rutas Exportadas:**
- `REPO_ROOT` = resultado de `findRepoRoot()`, ej. `C:\Users\cmktc\proyectos\video-factory`.
- `STORAGE_DIR` = `process.env['VF_STORAGE_DIR'] ?? resolve(REPO_ROOT, 'storage')` (línea 30). **Forzada por next.config.mjs, así que siempre apunta a C:\Users\cmktc\proyectos\video-factory\storage**.
- `RUNS_DIR` = `resolve(STORAGE_DIR, 'runs')` — workdirs + outputs de renders + artifacts.
- `RIPS_DIR` = `resolve(STORAGE_DIR, 'rips')` — análisis de ad de referencia (ripeo).
- `TRAINING_DIR` = `resolve(STORAGE_DIR, 'training')` — iteraciones de aprendizaje de formato.
- `PRESETS_DIR` = `resolve(REPO_ROOT, 'packages', 'presets')` — presets estables.
- `PENDING_PRESETS_DIR` = `resolve(PRESETS_DIR, 'pending')` — presets aprendidos en espera de aprobación admin.
- `SUGERENCIAS_DIR` = `resolve(STORAGE_DIR, 'sugerencias')` — feedback del owner persistido como JSON.
- `PREVIEWS_DIR` = `resolve(STORAGE_DIR, 'previews')` — planes de escenas de previewes (Parte 3 estable).
- `CONVERSATIONS_DIR` = `resolve(STORAGE_DIR, 'conversations')` — historiales Copilot por usuario.

**Funciones Helper:**
- `workDirFor(runId)` → `<RUNS_DIR>/<runId>/`.
- `outputPathFor(runId)` → `<RUNS_DIR>/<runId>/final.mp4`.
- `ripWorkDirFor(ripId)` → `<RIPS_DIR>/<ripId>/`.
- `trainingWorkDirFor(trainingId)` → `<TRAINING_DIR>/<trainingId>/`.
- `previewPlanPath(previewId)` → `<PREVIEWS_DIR>/<previewId>.json`.

### 3. Base de Datos: SQLite + Drizzle ORM + libsql

**Archivos clave:**
- `apps/web/lib/db.ts:1-43` — inicialización con lazy proxy.
- `db/schema.ts:1-154` — esquema de 3 tablas.
- `drizzle.config.ts:1-12` — configuración de migrations.
- `db/migrations/000{0,1,2,3,4,5}_*.sql` — histórico de cambios de schema.

#### 3.1 Inicialización de la Conexión

```typescript
function buildDbUrl(): string {
  const fromEnv = process.env['DATABASE_URL'];
  const raw = fromEnv ?? `file:${resolve(REPO_ROOT, 'db', 'local.db')}`;
  
  // Si DATABASE_URL=file:./db/local.db (relativo), resolvemos contra REPO_ROOT
  // porque libsql lo resolvería contra cwd=apps/web en dev → path falso.
  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length);
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/');
    if (!isAbsolute) {
      return `file:${resolve(REPO_ROOT, path)}`;
    }
  }
  return raw;
}

function init(): LibSQLDatabase {
  if (!_db) {
    _client = createClient({ url: buildDbUrl() });
    _db = drizzle(_client);
  }
  return _db;
}

// Proxy lazy: difiere la conexión hasta el primer acceso real.
export const db = new Proxy({} as LibSQLDatabase, {
  get(_target, prop, receiver) {
    return Reflect.get(init() as object, prop, receiver);
  },
});
```

**Rationale:** 
- **Lazy initialization** (líneas 37-41): Evita que Next.js abra la DB durante "collect page data" del build (no-op en build, se abre en runtime). 
- **Path resolution** (líneas 10-25): DATABASE_URL puede ser relativo; libsql lo resuelve contra el cwd actual. En dev, cwd=apps/web, así que `file:./db/local.db` → apps/web/db/local.db (falso). **Solución:** detectar si es relativo, resolver contra REPO_ROOT.

#### 3.2 Schema de Base de Datos

**Tabla `runs`** (lineas 4-69 de schema.ts):
- `id` TEXT PRIMARY KEY — UUID del run.
- `brand_id`, `preset_id`, `product_id` (opcional) — identificación de run.
- `script_raw` TEXT — guion original del usuario.
- `status` ENUM ('pending'|'running'|'completed'|'completed-with-warnings'|'failed') — estado actual.
  - **Status `completed-with-warnings`** (v3.2 #105, 28-may-2026): Video entregado pero editor post-render marcó advisories. Mejor que 'failed' (owner sin nada). Editor post-render genera `post-render-report.json` con findings que se muestran en la UI.
- `workDir`, `outputPath`, `durationSeconds`, `errorMessage` — salida/metadatos.
- `currentStep`, `progress` — tracking durante ejecución.
- `estimatedCostUsd`, `imageCount`, `ttsCharsBilled` — metraje de costos.
- `deletedAt` (timestamp) — soft-delete; NULL=visible. Cron periódico purga registros con deletedAt < ahora - 30 días.
- `originalRunId` — si es corrección de otro run, apunta al padre → linaje de iteraciones.
- `startedAt`, `completedAt`, `createdAt` (timestamps) — duración.
- **Campos colaborativos** (v3.2 #114, 28-may-2026):
  - `mode` ENUM ('auto'|'collaborative') DEFAULT 'auto' — 'auto' = todo sin pausa, 'collaborative' = pausa entre scenes esperando aprobación.
  - `pausedAtSceneIndex` INTEGER — qué scene espera aprobación si mode='collaborative'.
  - `awaitingApproval` INTEGER (boolean) — ¿pipeline esperando intervención humana?

**Tabla `rips`** (líneas 78-98 de schema.ts):
- `id` TEXT PRIMARY KEY — UUID del ripeo.
- `videoPath`, `videoFileName`, `videoBytes` — archivo subido.
- `status` ENUM ('uploaded'|'analyzing'|'analyzed'|'failed') — etapa actual.
- `analysisJson` TEXT — AdAnalysis serializado (Gemini multimodal).
- `errorMessage`, `createdAt`, `analyzedAt` (timestamps).

**Tabla `training_videos`** (líneas 114-150 de schema.ts):
- `id` TEXT PRIMARY KEY.
- `videoPath`, `videoFileName`, `videoBytes` — archivo subido.
- `status` ENUM ('uploaded'|'analyzing'|'training'|'completed'|'failed').
- `analysisJson` — AdAnalysis (Gemini multimodal).
- `trajectoryJson` — TrainingTrajectory serializado (keyframes + iteraciones con scores).
- `resultPresetId` — ID del preset destilado si convergió.
- `generalIdeasJson` — 3-5 bullets sobre línea editorial, hook, paleta, ritmo.
- `currentStep`, `progress`, `errorMessage`, `trainedAt` (timestamp).

#### 3.3 Migrations

Drizzle mantiene el esquema en `db/schema.ts` y genera migrations automáticamente:
- `drizzle.config.ts` → schema=`db/schema.ts`, out=`db/migrations`, dialect='sqlite'.
- Comando: `pnpm drizzle-kit generate:sqlite` → genera `.sql` en `db/migrations/`.
- Comando: `pnpm drizzle-kit push:sqlite` → aplica al archivo `db/local.db`.

**Histórico de migrations:**
- `0000_normal_peter_quill.sql` — tabla `runs` inicial.
- `0001_magenta_scarlet_spider.sql` — (pendiente lectura, probablemente campos tempranos).
- `0002_repository_and_cost.sql` — agrega `product_id`, `estimated_cost_usd`, `image_count`, `tts_chars_billed`, `deleted_at`, `original_run_id`.
- `0003_rips_table.sql` — crea tabla `rips`.
- `0004_training_videos.sql` — crea tabla `training_videos`.
- `0005_furry_colossus.sql` — agrega campos colaborativos: `mode`, `paused_at_scene_index`, `awaiting_approval`.

### 4. Seguimiento de Costos: `CostTracker`

**Archivo clave:** `apps/web/lib/cost-tracker.ts:1-107`

**Propósito:** Acumula eventos de costo en memoria durante un run; al final, persiste el total a `runs.estimated_cost_usd` + desglose por tipo (imagen, TTS, etc.).

**Precios configurados** (actualizar cuando cambien tarifas de proveedores):
- `TTS_OPENAI_PER_1K_CHARS = 0.015` (tts-1).
- `TTS_ELEVENLABS_PER_1K_CHARS = 0.18` (Starter plan estimado).
- `OPENAI_IMAGE_MEDIUM_PORTRAIT = 0.04` (gpt-image-1, 1024x1536, medium).
- `OPENAI_IMAGE_HIGH_PORTRAIT = 0.17` (high).
- `OPENAI_IMAGE_LOW_PORTRAIT = 0.011` (low).
- Gemini Flash / Pro (input/output por 1k tokens).
- `GEMINI_VISION_FLAT_PER_IMAGE = 0.001` (estimado conservador).

**Métodos Públicos:**
- `addImage(provider, quality)` — registra generación de imagen. Providers soportados: 'openai', 'vertex', 'aistudio', 'higgsfield', 'fal', 'unknown'.
  - Nota **GOTCHA 1 (Veo subestimado)**: Línea 1691 del pipeline: clips Veo se logean como `addImage('higgsfield', 'high')` (~$0.04 placeholder), pero Veo realmente cuesta $0.10-0.40 por clip. **El precio está subestimado**. Comentario en código: "refinar después con precio real Veo" (NO se refinó aún).
  - Nota: Higgsfield DoP, Kling, FAL tienen precios aproximados; ajustar si los proveedores publican nuevas tarifas.
  
- `addTts(provider, charCount)` — registra síntesis de voz. Providers: 'elevenlabs' | 'openai'. Calcula costo como `(charCount / 1000) * rate`.

- `addGeminiVision(model, imageCount)` — registra análisis de imagen vía Gemini Vision. Modelos: 'flash' | 'pro'.

- `addGeminiText(model, inputChars, outputChars)` — registra procesamiento de texto vía Gemini. Estima tokens como `chars / 4`.

- `get total()` → suma de todos los costos.

- `get summary()` → `{totalUsd, imageCount, ttsChars, events[]}`.

**Integración en Pipeline** (líneas 230-2363 de pipeline.ts):
- Línea 230: `const costTracker = new CostTracker()`.
- Durante la ejecución se llama a `costTracker.addImage(...)`, `costTracker.addTts(...)`, etc. según bloques.
- Línea 2201: `const costSummary = costTracker.summary`.
- Líneas 2259-2261: Al completar, actualiza el run en la DB:
  ```typescript
  estimatedCostUsd: costSummary.totalUsd,
  imageCount: costSummary.imageCount,
  ttsCharsBilled: costSummary.ttsChars,
  ```

**GOTCHA 2 (No contabilizado):** El costo de Gemini Vision (format-audit, post-render-judge) se llama pero **NO se suma a estimatedCostUsd**. Esos llamados están para auditoría y no se registran en la facturación visible del run. Esto es por diseño (auditoría interna sin pasar al cliente), pero si se decide cambiar, hay que agregar lógica de acumulación.

### 5. Autenticación y Variables de Entorno Protegidas

**Archivo clave:** `apps/web/lib/auth.ts:1-70`

**Estructura de Credenciales:**

1. **APP_PASSWORD** — clave para entrar a la app (login normal). 
   - Función `checkPassword(submitted)` compara contra `process.env['APP_PASSWORD']`.
   - Función `setAuthCookie()` / `clearAuthCookie()` / `isAuthenticated()` — maneja cookie `app_auth`.
   - Cookie: httpOnly, sameSite='strict', maxAge=30 días.

2. **ADMIN_PASSWORD** — clave SEPARADA para acceso a `/admin` y `/api/admin/*`.
   - Distinta de APP_PASSWORD: aunque alguien entre a la app, **NO entra al admin sin esta clave**.
   - Función `isAdminConfigured()` — retorna true si la var está en el .env y no está vacía.
   - Función `checkAdminPassword(submitted)`.
   - Función `setAdminCookie()` / `isAdmin()` — maneja cookie `admin_auth`.
   - Cookie: httpOnly, sameSite='strict', maxAge=8 horas (caduca antes que app_auth).
   - Si `ADMIN_PASSWORD` está vacía, `/admin` retorna 503 (no disponible).

**Middleware de Protección** (`apps/web/middleware.ts:4-48`):
- Lineas 9-14: Si path comienza con `/api/admin` (excepto `/api/admin/login`), verifica cookie `admin_auth`. Si falta, retorna 401.
- Lineas 16-21: Para todo el resto (`/create`, `/runs`, `/rip`, `/admin`, `/aprendizaje`), verifica cookie `app_auth`. Si falta, redirige a `/` (login).
- Línea 22-32: En dev, establece headers no-cache para forzar recarga fresca del browser (mejora experiencia de desarrollo).

**Matcher de rutas protegidas** (línea 40-47):
```javascript
export const config = {
  matcher: [
    '/create/:path*',
    '/runs/:path*',
    '/rip/:path*',
    '/admin/:path*',
    '/aprendizaje/:path*',
    '/api/admin/:path*',
  ],
};
```
Nota: `/brands` **no está protegida** (bug pre-existente; fuera del scope). `/onboarding` es pública por diseño (wizard pre-auth).

### 6. Variables de Entorno Consumidas por el Sistema

**Cargadas en `.env` raíz (ejemplo de .env.example):**

**Core / Autenticación:**
- `APP_PASSWORD` (requerida) — clave de app.
- `ADMIN_PASSWORD` (opcional, recomendada) — clave de admin. Si está vacía, admin cerrado.
- `PORT` (default 3000) — puerto Next.js.
- `APP_URL` (default http://localhost:3000) — URL pública para callbacks.
- `LOG_LEVEL` (default 'info') — nivel de logging ('debug'|'info'|'warn'|'error').

**Base de Datos:**
- `DATABASE_URL` (default `file:./db/local.db`) — URL libsql. Relativa resuelve contra REPO_ROOT.

**APIs de Generación (requeridas):**
- `OPENAI_API_KEY` (requerida) — generación de imágenes (gpt-image-1) + TTS (tts-1 fallback).
- `ELEVENLABS_API_KEY` (requerida) — TTS principal.
- `GOOGLE_AI_API_KEY` (requerida) — Gemini Vision (analysis), Imagen, Speech-to-Text.
- `GOOGLE_SPEECH_API_KEY` (opcional) — Speech-to-Text dedicada (subtítulos-google prefiere esta).
- `ANTHROPIC_API_KEY` (recomendada, requerida para Copilot/editor IA) — Claude (judge, editor, chat). **Tratada como inactiva si comienza con 'ROTATE_'**.

**Google Cloud (recomendado):**
- `GCP_PROJECT_ID` — proyecto Vertex AI.
- `GOOGLE_APPLICATION_CREDENTIALS` — ruta a JSON del service account (necesita rol "Vertex AI User").
- `GCP_LOCATION` (default 'us-central1') — región de Vertex.

**Proveedores de Respaldo (opcionales):**
- `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET` — Flux Pro Kontext (imágenes) + DoP (video).
- `KLING_ACCESS_KEY`, `KLING_SECRET_KEY` — Kling AI image-to-video.
- `FAL_API_KEY` — FAL.AI (flux-pro alternativo).

**Subtítulos y Sync:**
- `ZAPCAP_API_KEY`, `ZAPCAP_WEBHOOK_SECRET` — subtítulos animados tipo CapCut.
- `VF_SYNC_INGEST_KEY` — token de recepción central (solo en instalación receptora).
- `VF_LEARNING_SYNC_URL`, `VF_LEARNING_SYNC_KEY` — URL y token de sync de KB central (OPT-IN, vacío=OFF).

**Auditoría y Compuerta de Calidad:**
- `VF_AUTO_AUDIT` (off por default) — "1" para ejecutar `deepAudit` agrupado al terminar videos.
- `VF_AUTO_AUDIT_EVERY` (default 5) — cada cuántos videos.
- `VF_AUTO_AUDIT_MAX_HOURS` (default 24) — adicionalmente, si pasaron tantas horas sin auditar.
- `VF_GATE_FAIL_ON` (default 'critical') — severidad mínima que vuelca a "fail".
- `VF_GATE_REVIEW_ON` (default 'high') — severidad mínima que vuelca a "revisar".
- `VF_GATE_USE_GEMINI` (off por default) — "1" para enchufar juez Gemini video+audio (lipsync, cortes, audio).

**Otros:**
- `AUTO_FIX_PROCESS_ON_REPORT` (v3.2 #123) — "1" para auto-fix automático sin esperar botón manual.
- `HEYGEN_API_KEY` — para generación de talking heads (opcional, prototipo).

**Nota sobre seguridad:** Ninguna clave se expone en el HTML/JS (todas son server-side). Las keys se leen en:
- `next.config.mjs` → process.env (runtime).
- API routes (`/api/*`) → funciones server-side que consumen `process.env.*`.
- Bloques del pipeline → `@video-factory/blocks/*` (nodejs).

### 7. Wirings No-Obvios y Trampas

#### Wiring 1: El `.env` raíz es cargado ANTES de que Next.js lo sea
- `next.config.mjs` es el PRIMER archivo que ejecuta Node.js cuando se inicia `next dev`/`next build`/`next start`.
- La lectura manual del `.env` en líneas 19-45 **ocurre antes** del loader de variables de Next.js.
- Por esto el override es seguro y confiable (no hay competencia de otros loaders).

#### Wiring 2: `VF_STORAGE_DIR` es forzada en tiempo de config
- **Línea 50 del next.config.mjs:** `process.env.VF_STORAGE_DIR = ...` — se establece **en tiempo de config**, no esperando que esté en el `.env`.
- Si el `.env` tuviera una `VF_STORAGE_DIR` distinta, **sería sobreescrita** por esta línea.
- Esto garantiza que todos los módulos (incluyendo scripts que corren fuera de Next.js) vean el mismo STORAGE_DIR.

#### Wiring 3: Lazy database proxy permite que el build no toque la DB
- Si la conexión fuera eager, Next.js intentaría conectarse durante `next build` → error de archivo abierto en Windows (DB locked).
- El Proxy lazy difiere la conexión hasta el primer acceso real (runtime), lo que es seguro.

#### Wiring 4: `buildDbUrl()` resuelve rutas relativas contra REPO_ROOT, no contra cwd
- `DATABASE_URL=file:./db/local.db` es ambiguo (relativo a quién?).
- El código detecta si es relativo y lo resuelve contra REPO_ROOT (no cwd).
- Esto es crítico: si dejara que libsql lo resuelva, en dev (cwd=apps/web) apuntaría a apps/web/db/local.db (falso).

#### Wiring 5: Cost tracking no se aplica al Veo bajo una política clara de desestimación
- Veo se loguea como `addImage('higgsfield', 'high')` en lugar de tener su propio método `addVeo()`.
- El precio $0.04 es un placeholder; Veo realmente cuesta $0.10-0.40.
- **Justificación:** Es intencional (desestimar el costo real para que estimatedCostUsd sea conservador). Si el dueño quiere precisión, hay que actualizar los precios.

#### Wiring 6: Gemini Vision no se suma a estimatedCostUsd
- Los llamados a Gemini (format-audit, post-render-judge, quality-gate) **no registran costo** en la estructura `CostEvent`.
- Esto es por diseño: esos gastos son internos (auditoría), no se facturan al cliente.
- Si la política cambia (el dueño quiere que se muestren), habría que integrar esos costos en `costTracker` y persistirlos en un campo aparte (ej. `costUsdInternal`).

#### Wiring 7: `ANTHROPIC_API_KEY` con prefijo 'ROTATE_' se trata como inactiva
- Líneas del pipeline (ej. 1314, 1376, 2221): `!process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')`.
- Si la key comienza con 'ROTATE_', todos los callouts a Claude se omiten o fallan silenciosamente.
- Esto es un "circuit-breaker" manual: si el dueño quiere rotar la key sin desconetar, la rebautiza.

#### Wiring 8: Admin protegido por TWO-FACTOR (dos cookies, dos claves)
- `app_auth` (APP_PASSWORD) + `admin_auth` (ADMIN_PASSWORD) son cookies distintas.
- Un empleado logueado sin admin_auth **no puede acceder a /admin**, aunque sepa la URL.
- El endpoint `/api/admin/login` requiere `isAuthenticated()` (ya en la app) + `checkAdminPassword()` para setear la cookie de admin.

---

## Estado Actual (verificado a partir de 8-jun-2026)

- **next.config.mjs:** Funcional, carga el .env raíz y sobreescribe process.env (25-may-2026 onwards).
- **db.ts:** Lazy proxy implementado, resuelve DATABASE_URL relativa contra REPO_ROOT.
- **schema.ts:** 3 tablas (runs, rips, training_videos) con 5 migrations aplicadas. Campo `mode`, `pausedAtSceneIndex`, `awaitingApproval` para modo colaborativo (v3.2 #114).
- **cost-tracker.ts:** Implementado, precios por proveedor configurados. **Veo subestimado, Gemini Vision no contabilizado.**
- **auth.ts:** Dos niveles de credenciales (APP_PASSWORD, ADMIN_PASSWORD). Middleware protege rutas.
- **paths.ts:** Resuelve REPO_ROOT robusto usando marcador pnpm-workspace.yaml. STORAGE_DIR apunta a <repoRoot>/storage.

---

## Gotchas (Trampas a No Re-descubrir)

1. **Veo subestimado en CostTracker:** Línea 1691 de pipeline.ts loguea clips Veo como `addImage('higgsfield', 'high')` (~$0.04 placeholder), pero Veo cuesta realmente $0.10-0.40. Si necesitas precisión, actualiza el precio. **Nota:** Es intencional (conservador), pero el comentario dice "refinar después".

2. **Gemini Vision no se suma a estimatedCostUsd:** format-audit, post-render-judge, quality-gate consumen Gemini Vision pero NO registran costo en `CostEvent`. Es por diseño (auditoría interna), pero si la política cambia, hay que agregar un campo separado para gastos internos.

3. **DATABASE_URL relativa se resuelve contra REPO_ROOT, no contra cwd:** Si usas `DATABASE_URL=file:./db/local.db`, no apunta a `apps/web/db/local.db` sino a `<repoRoot>/db/local.db`. Esto es correcto, pero si cambias el cwd esperando que se resuelva localmente, fallará.

4. **next.config.mjs ejecuta ANTES que cualquier otro módulo:** El override de process.env desde el .env ocurre al arrancar Next.js. Si un modulo intenta leer `process.env.FOO` en el import-time (no en runtime), **debe confiar en que next.config.mjs ya lo inyectó**. Evita lógica de auto-inicialización en el import-time que dependa de process.env (usa lazy init).

5. **Lazy database proxy previene build, pero falla en SSR si no se espera:** Si un Server Component intenta `await db.query()` sin manejar promesas, puede fallar silenciosamente. El Proxy es opaco (no es una Promise). Usar `await db.query()` es seguro, pero confiar en comportamiento síncrono puede fallar.

6. **AdminPassword vacía desactiva /admin (no error, HTTP 503):** Si `ADMIN_PASSWORD` no está configurada o está vacía, `/api/admin/login` retorna 503 (Service Unavailable) con mensaje "ADMIN_PASSWORD no está configurada". No es un 401 (Unauthorized); es un 503 (no disponible). Esto es deliberado.

7. **ANTHROPIC_API_KEY con prefijo 'ROTATE_' se trata como inactiva:** Si ejecutas `grep ROTATE_ .env` y encuentras la key rebautizada así, la IA quedó desconectada. El dueño lo hace para "rotar" sin downtime real (set en pausa). Verifica el prefijo si el judge IA falla silenciosamente.

8. **Storage split-brain si process.cwd() es erróneo:** Si corres un script desde una ruta distinta a la raíz/apps/web, `findRepoRoot()` puede fallar (no encuentra pnpm-workspace.yaml). Fallback es `resolve(process.cwd(), '..', '..')`, que puede estar fuera del repo. Siempre invoca scripts desde la raíz o desde apps/web (no desde packages/*).

9. **Soft-delete (deletedAt) no se purga automáticamente:** El campo `deleted_at` es un timestamp de soft-delete. Un "cron periódico" debe purgar registros viejos (>30 días), pero **ese cron no está implementado aún**. Los registros se acumulan en la DB (no es problema grave, pero factorizar para limpieza futura).

10. **Cost summary persiste al final del run, no incrementalmente:** El `costTracker` acumula en memoria; al final (línea 2259-2261) se escribe `estimatedCostUsd` al run. Si el run falla a mitad, los costos acumulados hasta ese momento **se pierden** (no se persistió). Para tracción de costos parciales, habría que guardar incrementalmente (cambio de arquitectura).

---

## Integración con el Resto del Sistema

- **Pipeline (apps/web/lib/pipeline.ts):** Usa `CostTracker` para acumular costos, `db` para persistir runs, `paths` para almacenamiento.
- **Autenticación (apps/web/middleware.ts, API routes):** Verifica cookies y claves de entorno para proteger rutas.
- **Format Audit, Post-Render Judge (kb/format-audit.ts, etc.):** Consumen `process.env['ANTHROPIC_API_KEY']` para juezes Claude.
- **Drizzle Migrations:** Se aplican con `pnpm drizzle-kit push:sqlite` (manual; no es automática en runtime).

---

## Próximos Pasos (Roadmap Implícito)

1. Implementar cron de limpieza de soft-deletes (30 días).
2. Refinar precios de Veo en CostTracker cuando se publiquen tarifas finales.
3. Decidir si Gemini Vision se suma a estimatedCostUsd o se reporta aparte.
4. Implementar persistencia incremental de costos si es crítico para auditoría.

**⚠️ Gotchas (14-infra-db-config (Configuración de Base de Datos e Infraestructura)):**
- Veo subestimado (~$0.04 placeholder vs $0.10-0.40 real) en CostTracker line 1691 pipeline.ts
- Gemini Vision NO se suma a estimatedCostUsd (por diseño: auditoría interna, no cliente)
- DATABASE_URL relativa se resuelve contra REPO_ROOT NO contra cwd — next.config.mjs line 50 fuerza VF_STORAGE_DIR siempre
- next.config.mjs ejecuta ANTES que otros módulos — confía en que process.env está inyectado
- Lazy database proxy impide que Build toque DB, pero falla en SSR si no se maneja promesas
- ADMIN_PASSWORD vacía = /admin retorna HTTP 503 (no disponible), no 401
- ANTHROPIC_API_KEY con prefijo ROTATE_ se trata como inactiva (circuit-breaker manual)
- Storage split-brain si process.cwd() fuera de repo — findRepoRoot() fallback puede estar fuera
- Soft-delete (deletedAt) NO se purga automáticamente — cron pendiente (>30 días)
- Cost summary persiste al final del run, no incrementalmente — costos parciales se pierden si falla


---

# Human Loop & Collaborative Mode — Referencia Completa

## Propósito

El **modo colaborativo** ("Hacer video en conjunto") permite que el owner participe ACTIVAMENTE durante la generación de un video: ve cada scene generada + validada por la IA, y puede APROBAR, RECHAZAR (con feedback), o solo COMENTAR. Las intervenciones se persisten y alimentan el aprendizaje cross-run del sistema.

## Cómo funciona end-to-end

### 1. Creación del run en modo colaborativo
- El owner crea un run con `mode: 'collaborative'` (vs. `mode: 'auto'` que es no-bloqueante).
- El run guarda `pausedAtSceneIndex`, `awaitingApproval` en la base de datos (`runs` table).

### 2. Pipeline pausa después de validar cada scene
- **Lugar:** `apps/web/lib/scene-animator.ts` (línea ~360): después de animar una scene y ejecutar el VALIDATOR, llama a `waitForApprovalIfCollaborative()`.
- **Flujo:**
  1. Lee el `mode` del run: si no es `'collaborative'`, return inmediato (action='approve', no bloquea).
  2. Si es colaborativo, setea `awaitingApproval: true` + `pausedAtSceneIndex: N` en DB y `currentStep: "aguardando aprobación · scene N"` (apps/web/lib/collaborative-mode.ts:85-92).
  3. Polling loop cada 5 segundos (POLL_INTERVAL_MS=5000) lee intervenciones pendientes vía `readPendingInterventions()`.
  4. **Loop termina cuando:**
     - El owner manda una intervención con type='approve', 'reject', o 'skip' → libera la pausa, retorna `{action, intervention, ...}`.
     - type='comment' → NO libera, solo acumula en `additionalComments[]` (comentarios que alimentan VALIDATOR pero no bloquean).
     - Timeout después de MAX_WAIT_MS=3,600,000ms (1 hora) → fallido.

### 3. Owner interactúa vía BuildCollaborative UI
- **Componente:** `/apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx`
- **Polling de estado:** cada 3 segundos (POLL_INTERVAL_MS=3000), actualiza:
  - `GET /api/runs/{id}` → status, progress, currentStep.
  - `GET /api/runs/{id}/collaborative-state` → awaitingApproval, pausedAtSceneIndex, mode.
  - `GET /api/runs/{id}/validator-history` → verdict histórico por scene.
  - `GET /api/runs/{id}/scene-plan` → guión + timing.
- **Cuando el owner clickea Aprobar/Rechazar/Comentar:**
  - POST `/api/runs/{id}/intervene` con `{type, sceneIndex, comment, newImagePrompt?, ...}`.

### 4. Intervención persiste y se procesa
- **Endpoint:** `/api/runs/{id}/intervene` (apps/web/app/api/runs/[id]/intervene/route.ts:59-136).
- **recordIntervention()** persiste a 3 lugares (owner-feedback.ts:138-220):
  1. `interventions.jsonl` (inbox de acciones pendientes) — lo que el pipeline polea.
  2. `run-feedback.jsonl` (historial completo del run para auditoría).
  3. `cross-run-memory/{brandId}/{presetId}.jsonl` — SOLO si `type !== 'skip'` + tiene comentario sustantivo (>5 chars) + contexto brand+preset (owner-feedback.ts:176-189).

### 5. Pipeline consume la intervención
- El polling loop en `waitForApprovalIfCollaborative()` (collaborative-mode.ts:110-113) lee `readPendingInterventions(runId, sceneIndex)`.
- **Para cada intervención:**
  - Si type='comment' → acumula en `additionalComments[]`, marca procesada, CONTINÚA el loop (no libera).
  - Si type='approve'/'reject'/'skip' → marca procesada (markInterventionProcessed), libera la pausa, retorna con la acción.

### 6. Pipeline interpreta la acción
- **Si action='reject':**
  - Scene-animator (scene-animator.ts:~368) llama `opts.validator.onRegenerateImage()` SIEMPRE.
  - Si `newImagePrompt` vacío pero hay comment, DERIVA el prompt: `CORRECTION DEL OWNER + comment` (scene-animator.ts:~375-380).
  - Regenera la imagen con el prompt corregido, reanima, valida de nuevo (vuelve al paso 2).
- **Si action='approve':**
  - Scene se da por aceptada, avanza a la siguiente.
- **Si action='skip':**
  - Scene se acepta sin validar, avanza.
- **Si action='comment-only':** (no existe en código actual, es un tipo teórico).

### 7. Before/After UI (v3.2 #128)
- **Cuando el owner rechaza:**
  - BuildCollaborative captura snapshot del asset rechazado como Blob URL (sobrevive overwrite en disco).
  - Muestra overlay "Regenerando…" con estado actual + estimación de tiempo.
- **Cuando la regen termina:**
  - Detecta nuevo attempt > previous.attempt.
  - Cambia a panel "Antes / Después" lado a lado: imagen rechazada + nueva.
  - Owner puede aprobar la nueva o rechazar de nuevo.

## Archivos y funciones clave

### Core de colaboración

| Archivo | Línea | Función | Propósito |
|---------|-------|---------|----------|
| `apps/web/lib/collaborative-mode.ts` | 57-185 | `waitForApprovalIfCollaborative()` | Pausa y polling del pipeline esperando intervención del owner. |
| `apps/web/lib/collaborative-mode.ts` | 190-206 | `isAwaitingApproval()` | Helper UI para saber estado actual (awaiting?, scene?, mode?). |
| `apps/web/lib/owner-feedback.ts` | 138-220 | `recordIntervention()` | Persiste intervención a 3 lugares (inbox, historial, cross-run memory). |
| `apps/web/lib/owner-feedback.ts` | 229-257 | `readPendingInterventions()` | Lee intervenciones NO procesadas para un run/scene. |
| `apps/web/lib/owner-feedback.ts` | 266-303 | `markInterventionProcessed()` | Marca intervención como consumida (reescribe JSONL atómicamente). |
| `apps/web/app/api/runs/[id]/intervene/route.ts` | 59-136 | POST `/api/runs/{id}/intervene` | Recibe acciones del owner (approve/reject/comment). |
| `apps/web/app/api/runs/[id]/intervene/route.ts` | 138-154 | GET `/api/runs/{id}/intervene` | Devuelve historial completo de intervenciones. |

### UI y componentes

| Archivo | Línea | Componente | Propósito |
|---------|-------|-----------|----------|
| `apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx` | 77-703 | `BuildCollaborative()` | Componente principal: muestra scenes, maneja submit. |
| `apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx` | 966-1468 | `CurrentSceneCard()` | Card con scores, issues, comentarios, botones approve/reject/skip/comment. |
| `apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx` | 1650-1743 | `RegeneratingPanel()` | Overlay mientras se regenera (spinner + estimación de tiempo). |
| `apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx` | 1754-1872 | `BeforeAfterPanel()` | Comparativa lado a lado (rechazado vs nuevo). |
| `apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx` | 1505-1594 | `SuggestionsPicker()` | Sugerencias pre-definidas contextuales por verdict. |

### Pre-prompt assistant (v3.2 #130)

| Archivo | Línea | Función | Propósito |
|---------|-------|---------|----------|
| `apps/web/app/api/runs/[id]/suggest-feedback/route.ts` | 132-221 | POST `/api/runs/{id}/suggest-feedback` | Expande observación corta del owner a comentario rico (contraste + descriptores). |
| `apps/web/app/api/runs/[id]/translate-feedback/route.ts` | (not read yet) | POST `/api/runs/{id}/translate-feedback` | Convierte feedback natural a prompt técnico en inglés vía Claude. |
| `apps/web/app/(app)/runs/[id]/build/BuildCollaborative.tsx` | 291-330 | `expandPrePrompt()` | Handler en BuildCollaborative que llama suggest-feedback. |

### Owner-feedback schemas y memory

| Archivo | Línea | Schema | Propósito |
|---------|-------|--------|----------|
| `apps/web/lib/owner-feedback.ts` | 26-47 | `InterventionType`, `InterventionCategory` | Enums de tipos y categorías de intervención. |
| `apps/web/lib/owner-feedback.ts` | 49-80 | `OwnerIntervention` | Schema Zod de intervención persistida. |
| `apps/web/lib/owner-feedback.ts` | 349-403 | `getRelevantCommentsForContext()` | Recupera comments del owner en runs previos del mismo brand+preset (VALIDATOR usa como contexto). |
| `apps/web/lib/owner-feedback.ts` | 419-465 | `getCommentStatsCrossRun()` | Agrupa comments por categoría, cuenta ocurrencias (para cerebro evolutivo). |
| `apps/web/lib/owner-feedback.ts` | 489-519 | `proposePatchesFromOwnerComments()` | Si N+ comments marcan misma categoría → propone patch al preset. |

## Entradas y salidas

### Input: Crear run colaborativo
```json
{
  "mode": "collaborative"  // vs "auto"
}
```

### Input: Intervención del owner
```json
{
  "type": "approve" | "reject" | "skip" | "comment" | "redirect-attention",
  "sceneIndex": 2,
  "category": "anatomy",  // opcional
  "comment": "Anatomía incorrecta (dedos). Regenerar con énfasis en 5 dedos visible.",
  "newImagePrompt": "...",  // opcional (solo reject)
  "newMotionPrompt": "..."  // opcional (solo reject)
}
```

### Output: Intervención persistida
```json
{
  "id": "abc123_xyz",
  "runId": "run-123",
  "sceneIndex": 2,
  "timestampIso": "2026-05-29T...",
  "type": "reject",
  "category": "anatomy",
  "comment": "Anatomía incorrecta...",
  "newImagePrompt": "...",
  "newMotionPrompt": null,
  "context": {
    "validatorVerdict": "wrong",
    "validatorConfidence": 0.65,
    "brandId": "vitaly",
    "presetId": "medical-authority",
    "productId": "serum-xyz"
  },
  "processed": false,
  "processedAtIso": null
}
```

### Output: ApprovalResult (del pipeline)
```json
{
  "action": "reject",
  "intervention": { ... },
  "newImagePrompt": "CORRECCIÓN DEL OWNER: ...",
  "newMotionPrompt": null,
  "additionalComments": ["Comentario 1", "Comentario 2"],
  "waitedMs": 45000
}
```

## Flujos clave

### Flujo A: Owner rechaza con comentario natural (el fix reciente)

**Problema (v3.2 #124):** El owner clickea "Rechazar" y escribe "Parece embarazada, debería ser hinchada" en el comentario. PERO el campo "PROMPT TÉCNICO" se queda vacío. Antes, el pipeline trataba eso como un reject sin prompt → no regeneraba (confusión).

**Solución (v3.2 #124 + #130):**

1. **Pre-prompt assistant (v3.2 #130):** Owner puede (opcionalmente) clickear "Generar comentario completo" → POST `/api/runs/{id}/suggest-feedback` expande "Parece embarazada" a un comentario rico con contraste (qué NO queremos vs qué SÍ, descriptores anatómicos, anclaje al script).

2. **Auto-traducción (v3.2 #124):** Cuando el owner clickea "Rechazar y regenerar" CON comentario PERO SIN prompt técnico:
   - BuildCollaborative setea `translating: true`.
   - POST `/api/runs/{id}/translate-feedback` → Claude convierte el comentario natural a un imagePrompt en inglés técnico.
   - Muestra preview de lo traducido (reasoning + correcciones aplicadas + parts preservadas).
   - El prompt traducido se manda como `newImagePrompt` en el intervene POST.

3. **Pipeline regenera SIEMPRE en reject (scene-animator.ts:~368-380):**
   ```typescript
   if (approval.action === 'reject' && opts.validator.onRegenerateImage) {
     const correctedPrompt =
       approval.newImagePrompt ||
       `${animated.imagePrompt}\n\nCORRECCIÓN DEL OWNER (...): ${approval.intervention?.comment ?? '...'}`;
     // Regenera con correctedPrompt
   }
   ```
   Si NO hay `newImagePrompt` pero hay comentario, DERIVA el prompt a partir del comentario.

### Flujo B: Owner rechaza y ve Antes/Después (v3.2 #128)

1. **Snapshot ANTES:** BuildCollaborative captura asset actual (imagen + clip mp4) como Blob URL local en memoria.
   ```typescript
   const snapshot = await Promise.all([
     captureAsset(`/api/runs/${runId}/scene-asset?file=scene_${padded}.png`),
     captureAsset(`/api/runs/${runId}/scene-asset?file=scene_${padded}.mp4`),
   ]);
   ```

2. **Regenerar:** POST `/api/runs/{id}/intervene` con reject. Pipeline regenera.

3. **UI Transición:**
   - Muestra `RegeneratingPanel` (spinner + "🎨 Generando imagen…" → "🎬 Animando…" → "🔍 VALIDATOR revisando…").
   - Cuando llega nuevo attempt (currentSceneEntry.attempt > previousScene.attempt), cambia a `BeforeAfterPanel`.

4. **Comparativa:** Lado a lado (❌ ANTES / ✅ DESPUÉS) con imagePrompts visible en dropdowns.

### Flujo C: Cross-run memory y cerebro evolutivo

1. **Persistencia:** recordIntervention() escribe a `cross-run-memory/{brandId}/{presetId}.jsonl` SOLO si:
   - type !== 'skip' (cualquier intervención sustantiva: approve/reject/comment/etc.).
   - comment existe + trim().length > 5.
   - contexto.brandId + contexto.presetId existen.

2. **Lectura en próximos runs:** `getRelevantCommentsForContext(brandId, presetId, sceneNarration?)` busca comments con keyword overlap con la narración actual.

3. **Proposición automática:** `proposePatchesFromOwnerComments()` si detecta 2+ runs distintos con 3+ comments en misma categoría → propone preset patch (gated, owner aprueba en /admin).

## Estado real (verificado en código actual)

### Características implementadas
- ✅ Pausa colaborativa con polling (MAX_WAIT=1h).
- ✅ Tres tipos de intervenciones que liberan pausa: approve/reject/skip.
- ✅ Type='comment' NO libera, acumula en additionalComments.
- ✅ Reject SIEMPRE regenera (incluso sin prompt explícito).
- ✅ Auto-traducción feedback natural → prompt técnico (v3.2 #124).
- ✅ Pre-prompt assistant (expande observación corta → comentario rico) (v3.2 #130).
- ✅ Snapshot antes/después con Blob URLs (v3.2 #128).
- ✅ Persistencia atómica de intervenciones (temp+rename) (v3.3).
- ✅ Cross-run memory (comentarios indexados por brand+preset).
- ✅ Proposición automática de preset patches (cerebro evolutivo).
- ✅ Evento a KB (`recordEvent` vía owner-feedback.ts:195-217).

### Características teóricas pero SIN implementación visible
- Type='redirect-attention' (en schema pero no en scene-animator).
- 'comment-only' acción explícita (type='comment' hace lo mismo).

### Configuración defaults
- `POLL_INTERVAL_MS = 5_000` (collaborative-mode.ts:30).
- `MAX_WAIT_MS = 3_600_000` (1 hora) (collaborative-mode.ts:31).
- `COMMENT_PATCH_THRESHOLD_RUNS = 2` (owner-feedback.ts:469).
- `COMMENT_PATCH_THRESHOLD_COMMENTS = 3` (owner-feedback.ts:470).

## Wirings no-obvios

1. **El pre-prompt system prompt (suggest-feedback/route.ts:77-130)** es MÁS LARGO que típicos—contiene 7 reglas de expansión y 2 ejemplos completos. Eso es intencional: la calidad de la expansión depende de que Claude entienda la regla #1 (interpretación literal) y la estructura "NO queremos X / SÍ queremos Y". Si se abrevia, el prompt se vuelve ambiguo.

2. **Comentarios se acumulan en additionalComments[] pero NO bloquean.** Esto permite que el owner deje feedback narrativo (que alimenta VALIDATOR para next scenes) SIN parar el pipeline. Después de rechazar, volver a este estado con approveAction=true libera definitivamente.

3. **markInterventionProcessed() reescribe TODO el JSONL.** Para N intervenciones pequeñas esto es O(N²) pero el volumen per-run es chico (típico 5-20 intervenciones). Si un run tiene 1000+ intervenciones, usar un índice separado o DB sería mejor (owner-feedback.ts:266-303).

4. **Blob URLs en BuildCollaborative:** Son referencias locales (memory:// URLs) que sobreviven overwrite en disco pero mueren al recargar la página. Para sesiones largas sin refresh, esto está bien. Para una sesión de 8h+, el memory podría fragmentarse (cleanup en useEffect mounted/unmounted) (BuildCollaborative.tsx:203-215).

5. **isAwaitingApproval() lee de DB cada poll.** No cachea. Si hay N navegadores abiertos, cada uno hace un GET a DB cada 3s. A escala esto es cheap (índice en awaitingApproval) pero visible en logs (BuildCollaborative.tsx:149).

6. **Pre-prompt uses Sonnet, not Haiku.** Porque la expansión requiere razonamiento fino sobre contraste visual + anclaje narrativo. El presupuesto es 2500 tokens + modelo premium (suggest-feedback/route.ts:200).

7. **El intervene endpoint valida que run.status ∈ ['running'|'pending'] + mode='collaborative'.** Si ya terminó (completed/failed), rechaza con 409 (intervene/route.ts:99-110). Esto evita intervenciones fantasma en forks.

## Gotchas y trampas a no re-descubrir

1. **NO asumir que el prompt técnico siempre está en `newImagePrompt`.** Puede venir vacío si el owner solo escribió comentario natural. El pipeline DERIVA el prompt a partir del comentario (scene-animator.ts:~375-380). La auto-traducción es un helper UI, no obligatoria.

2. **"Rechazar sin feedback" era un bug antiguo.** Si type='reject' pero NO comment + NO newImagePrompt, el intervene endpoint antes no lo bloqueaba. Ahora sí requiere newImagePrompt O comment (intervene/route.ts:86-91). El comentario solo se vuelve opcional si newImagePrompt no vacío.

3. **Cross-run memory NUNCA se alimenta de type='skip'.** Aunque el skip se persiste a interventions.jsonl y run-feedback.jsonl, NO va a cross-run-memory. Esto es intencionado: un skip es "aceptar tal cual", no señal de mejora (owner-feedback.ts:181).

4. **Blob URLs de before/after se limpian en useEffect unmount.** Si el owner navega fuera de BuildCollaborative mid-regeneración SIN disparar dismount (page reload, etc.), quedan huérfanos en memoria (~10 MB × N rechazos). Defensiva: use el ref pattern + cleanup (BuildCollaborative.tsx:203-215 + 432-441).

5. **El MAX_WAIT_MS de 1 hora es por diseño para "owner que se reinicia el browser".** No es un timeout de inactividad — si el owner hace una intervención, se resetea el reloj (waitForApprovalIfCollaborative retorna inmediato con la acción). Es solo para runs que quedan pegados indefinidamente (bug del backend, owner desapareció, etc.).

6. **La pre-prompt expansion ES un LLM call (no es template).** Si Claude está down o la cuota agota, el owner verá error en tiempo real. No hay fallback a template, así que no dejes al propietario colgado sin feedback. Mejor: manda error claro + opción de escribir comentario manualmente (suggest-feedback/route.ts:209-220 retorna 502 con detail).

7. **El cross-run-memory indexado por brandId + presetId depende de contexto.** Si una intervención NO tiene brandId/presetId en contexto, no alimenta memoria cross-run. Asegúrate que recordIntervention() siempre recibe contexto completo (intervene/route.ts:120-125).

8. **reject + newMotionPrompt para arreglarlo.** Rara vez usado (mayormente newImagePrompt), pero existe si la animación también está mal. Si mandas solo newMotionPrompt sin newImagePrompt, el pipeline regenera la IMAGEN con prompt derivado del comentario, pero usará el newMotionPrompt para la animación (conditional en scene-animator.ts:~375-395).

9. **BuildCollaborative polling cada 3s, collaborative-mode.ts polling cada 5s.** Son independientes: UI sabe que cambió el estado antes que el backend lo persista. Puede haber una ventana de 2-5s de asincronía visual, pero no es race condition (el intervene POST es atómico vía DB).

10. **Pre-prompt assistant y feedback translator son rutas separadas.** Owner PUEDE:
    - Solo pre-prompt: genera comentario rico, lo edita, luego "Rechazar".
    - Pre-prompt + auto-traducción: genera comentario, clickea "Rechazar", auto-traduce a prompt técnico.
    - Skip pre-prompt: escribe comentario directo, "Rechazar" lo auto-traduce.
    El builder es flexible (BuildCollaborative.tsx:292-330 + 369-383).

**⚠️ Gotchas (15-human-loop-collab: Modo colaborativo + intervenciones del owner en vivo (co-creación scene-by-scene, reject con regeneración, pre-prompt assistant)):**
- NO asumir que newImagePrompt siempre está lleno: el pipeline DERIVA el prompt a partir del comentario si está vacío (scene-animator.ts ~375-380). La auto-traducción es UI helper, no requisito.
- 'Rechazar sin feedback' era bug: ahora intervene/route.ts:86-91 requiere newImagePrompt O comment. Vacío en ambos = 400 error.
- Blob URLs de before/after se limpan en useEffect unmount (BuildCollaborative.tsx:203-215). Si page reload mid-regen sin cleanup = memory leak (~10MB × N rechazos).
- MAX_WAIT_MS=1h es por design (owner restart browser), NO inactividad. Reset en cada intervención completada.
- Pre-prompt expansion es LLM call (no template fallback). Si Claude down = error en tiempo real. Manda error claro, opción manual (suggest-feedback/route.ts:209-220).
- Cross-run-memory NUNCA se alimenta de type='skip' — intencionado, un skip no es señal de mejora (owner-feedback.ts:181).
- cross-run-memory depende de contexto.brandId + presetId. Sin ellos, no alimenta memoria. Asegura contexto en recordIntervention() (intervene/route.ts:120-125).
- reject + newMotionPrompt arregla animación, no imagen. Si solo newMotionPrompt sin newImagePrompt = imagen regenera con prompt derivado del comentario, animación usa newMotionPrompt (scene-animator.ts ~395).
- UI polling cada 3s, backend collaborative-mode polling cada 5s: asincronía visual posible pero no race condition (intervene POST atómico vía DB).
- Pre-prompt + feedback-translator son rutas separadas, flujo flexible: owner puede skip pre-prompt, O generar comentario + editar + rechazar, O rechazar directo (auto-traduce). Diseño intencional (BuildCollaborative.tsx:292-330).


---

# Subsistema 16-scripts-cli — Scripts y Utilidades CLI

## Propósito General

El directorio `scripts/` contiene **118 utilidades** CLI (TypeScript compiladas con `tsx`, CommonJS, bash) que cubren:

1. **Herramientas de producción activas**: generación de assets, preparación de claves, síntesis de audios, validación de calidad.
2. **Vigilantes temporales** (`_tmp-*`): monitores ephemeral que se crean/destruyen en sesiones de desarrollo.
3. **Probes/tests**: exploración de providers (Gemini, Higgsfield, Kling, Veo, OpenAI), validación de esquemas, smoke tests.
4. **Operaciones legacy**: scripts de ciclos de trabajo viejos (test4, test5...) que quedan por referencia histórica pero NO son parte del flujo actual.

## Estado Real del Inventario (Junio 2026)

**Scripts activos y documentados en CLAUDE.md:**

| Script | Tipo | Propósito | Detalles |
|--------|------|----------|----------|
| `sync-invariants.ts` | TS | Sincronización bidireccional de invariantes | Lee `storage/kb/invariantes.jsonl` → renderiza markdown → actualiza CLAUDE.md entre marcadores `<!-- INVARIANTES:START -->` y `<!-- INVARIANTES:END -->` (línea 4) |
| `video-intelligence.ts` | TS | Análisis profundo de video (percepción) | Orquesta Gemini 2.5 Pro nativo (VE+OYE) + motion-map + persistencia. Genera `VideoIntelligenceReport`. Punto de entrada para "APRENDER un formato" (línea 19-35) |
| `transcribe-gemini.ts` | TS | Transcripción temporal de audio | Env local ROOT='C:\\Users\\cmktc\\proyectos\\video-factory' (línea 7). Carga GOOGLE_AI_API_KEY, envía audio base64 a Gemini 2.5 Pro con prompt JSON-estructurado. Timestamps palabra-por-palabra. Verificación crítica para lipsync (línea 1-45) |
| `prep-key.ts` | TS | Preparación lipsync NATIVO (Veo) | Concatena audio NATIVO de 2 clips Veo (hook + off, sin TTS aparte). Regla invariante: lipsync = voz del MISMO modelo que genera el video. Genera `manifest-key.json` con duraciones reales (línea 1-86) |
| `heygen-medico.ts` | TS | Generación clip HeyGen (DEPRECATED) | ⚠️ **CONTRADICCIÓN**: Script sigue usando HeyGen + TTS. Invariante jun-2026 establecida: "Veo 3.1 nativa, NUNCA HeyGen+TTS encima". Este script es artefacto pre-corrección (línea 1-61) |
| `prep-supercalm-assets.ts` | TS | Preparación assets SuperCalm | Extrae voz del médico, recorta fondo verde → webm alpha, escribe manifest.json. Base para composición. Usa `prepareVideoCutout` (línea 1-73) |
| `prep-sc20.ts` | TS | Preparación proto-sc20 (lipsync nativo) | Versión anterior a prep-key. Concat de 3 clips con audio nativo. Genera `manifest-sc20.json`. Similar a prep-key pero pipeline viejo (línea 1-51) |
| `run-quality-gate.ts` | TS | Compuerta de calidad (CLI wrapper) | Punto de entrada CLI para `runQualityGate()`. Carga análisis del rip (si `--rip`), corre panel multi-agente, emite veredicto con exit-code semántico (0=pasa, 1=revisar, 2=falla). Sin `--gemini` corre rápido; con `--gemini` usa Haiku para auditoría profunda (línea 1-175) |
| `run-format-audit.ts` | TS | Auditoría comparativa formato (CLI) | Similar a `run-quality-gate` pero enfocado en "fidelidad al original". Corre cuando se ripea un ad. |
| `check-run.ts` | TS | Imprime estado de un run | Query simple a DB: status, currentStep, errorMessage. Para debugging (línea 1-27) |
| `watch-run.ts` | TS | Watcher en vivo de progreso de run | Polls cada 2s el dir storage/runs/[runId]. Muestra barras de progreso de escenas, audio, final.mp4. Sale cuando final.mp4 estable (línea 1-140) |
| `migrate.ts` | TS | Migración DB (Drizzle) | En package.json como `pnpm db:migrate` → `npx tsx scripts/migrate.ts` |
| `mark-run-failed.ts` | TS | Marca run como fallido | Utility para cambiar estado en DB |
| `pick-run-for-repair.ts` | TS | Selecciona run para reparación | Interactivo: lista runs con hallazgos bloqueantes, elige uno. Wiring para "círculo de mejora" (Fase 2, Entrega 1) |
| `inspect-repairs.ts` | TS | Inspecciona historial de reparaciones | Revisa output de `executeGateRepair` |

**Scripts de visualización/conversión:**

| Script | Tipo | Propósito |
|--------|------|----------|
| `extract-audio.ts` | TS | Extrae audio de un video → mp3 |
| `extract-frame.ts` | TS | Extrae un frame a PNG |
| `extract-frames-at.ts` | TS | Extrae frames en timestampts específicos |
| `extract-frames-key11.ts` | TS | Extrae frames clave del proto SuperCalm |
| `extract-mosaic.ts` | TS | Crea mosaico visual de frames |
| `analyze-audio.ts` | TS | Análisis de audio (frequencies, RMS) |
| `detect-cuts.ts` | TS | Detecta cortes/cambios de plano vía frame-diff |

**Watchers temporales (actuales, creadosFN en últimas sesiones de dev):**

| Script | Tipo | Propósito | Estado |
|--------|------|----------|--------|
| `_tmp-copilot-preview-watcher.cjs` | CJS | Sigue un run específico (cc35603e...) e imprime previa de escenas en aprobación (audio incluido). Abre el .mp4 automáticamente. | 📅 Creado jun-8 00:28 — para debugging de Copilot interactivo |
| `_tmp-copilot-watcher2.cjs` | CJS | Auto-detector: sigue el run ACTIVO más nuevo (no roto) e imprime previews. Sin runId hardcodeado. | 📅 Creado jun-8 00:59 — versión mejorada del anterior |
| `monitor-rip.sh` | Bash | Monitorea rip en ejecución. Polls cada 20s, reporta status/progress/step. Login con APP_PASSWORD. | Estable, para CI/monitoring |

**Probes (exploración de providers) — efímeros, para validación:**

| Script | Tipo | Propósito |
|--------|------|----------|
| `probe-vertex.ts` | TS | Test básico de Vertex AI |
| `probe-vertex-veo.ts` | TS | Test Veo 3.1 vía Vertex |
| `probe-gemini-image.ts` | TS | Test Claude Vision sobre imagen |
| `probe-kling.ts` | TS | Test Kling v2-6 |
| `probe-higgsfield.ts` | TS | Test Higgsfield DoP |
| `probe-imagen-model.ts` | TS | Test Imagen text-to-image |
| `probe-openai.ts` | TS | Test OpenAI (legacy) |
| `probe-correction.ts` / `probe-correction-via-api.ts` | TS | Test correcciones de corrección automática |
| `probe-video-scenes.cjs` | CJS | Extrae info de scene-plan.json |

**Smoke tests (validación end-to-end de pipelines):**

| Script | Tipo | Propósito |
|--------|------|----------|
| `smoke-render.ts` | TS | Renderiza escenas básicas |
| `smoke-veo-render.ts` / `smoke-veo-realista.ts` | TS | Smoke test con Veo para humanos realistas |
| `smoke-escenas.ts` | TS | Valida composición de escenas |
| `smoke-animado-sepia.ts` / `smoke-animado-largo.ts` | TS | Tests de animación en composición |
| `smoke-perros.ts` / `smoke-perros-fast.ts` | TS | Smoke tests (payload específico de prueba) |
| `smoke-premium.ts` | TS | Smoke test de formato premium |
| `smoke-ui-flow.ts` | TS | Test del flujo UI básico |

**Tests de validadores y lógica:**

| Script | Tipo | Propósito |
|--------|------|----------|
| `test-validator.ts` / `test-validator-v3.ts` / `test-validator-fixture.ts` | TS | Unidad de anatomía validator |
| `test-validator-logical-coherence.ts` | TS | Coherencia narrativa del script |
| `test-text-overlay-render.ts` | TS | Renderizado de text overlays |
| `test-scene-planner-overlays.ts` | TS | Planificación de anotaciones |
| `test-narrator-context-fix.ts` | TS | Contexto del narrador (fijo post-invariante) |
| `test-cascade-bug1-regex.ts` | TS | Regresión de parsing de cascada (legacy) |
| `test-ad-analyzer.ts` / `test-ad-analyzer.cjs` | TS/CJS | Unit test del analizador de ads |
| `test-error-memory-feedback.ts` | TS | Feedback loop de error-memory (KB) |

**Tests específicos de comportamiento:**

| Script | Tipo | Propósito |
|--------|------|----------|
| `test-kling-balance.cjs` | CJS | Balance/concurrency de Kling |
| `test-anthropic-key.cjs` | CJS | Validar ANTHROPIC_API_KEY |
| `test-judge-smoke.cjs` | CJS | Smoke test del judge (M5) |
| `test-video-understander.cjs` | CJS | Test video-understander (M7) |
| `test-auto-learn-preset.cjs` | CJS | Test auto-learning de presets (M7) |
| `test-chat-discuss.cjs` | CJS | Test Copilot chat (M8) |
| `test-editor-flow.cjs` / `test-editor-verdict-standalone.cjs` / etc. | CJS | Tests del loop editor (M6) |
| `test-m9-context.cjs` | CJS | Test inyección system-context (M9) |
| `test-higgsfield-video.cjs` | CJS | Test de clip con Higgsfield |
| `test-prompt-extraction.cjs` | CJS | Parsing de prompts de guiones |

**Operaciones/setup:**

| Script | Tipo | Propósito |
|--------|------|----------|
| `check-brand-schema.ts` | TS | Valida schema de marcas |
| `check-preset-schema.ts` | TS | Valida schema de presets |
| `check-run-state.cjs` | CJS | Mira estado de run en DB (minimalista) |
| `preflight-db-check.cjs` | CJS | Pre-vuelo: valida BD accesible |
| `validate-learned-vitaly-preset.cjs` | CJS | Valida preset aprendido |
| `validate-scene-count.cjs` | CJS | Cuenta escenas esperadas vs. reales |
| `validate-brain-evolution.cjs` | CJS | Valida estado del "cerebro evolutivo" (M7) |

**Operaciones legacy (flujo viejo test4/test5/...):**

Estos scripts quedan como referencia histórica pero YA NO son parte del pipeline actual:

- **launch-test*.cjs** (test4, test5, test8, test9, test10, test11): Lanzaban runs en ciclos de prueba específicos. Ya reemplazados por el flujo interactivo en la UI.
- **monitor-test*.cjs** (test4, test5, test6, test7, test8, test9, test10, test11): Monitoraban esos runs. Ya obsoletos.
- **check-test*.cjs**: Chequeaban estado. Ya no se usan.
- **step1-kill-zombies-only.cjs**, **step1b-kill-test4-zombie.cjs**, **step2-launch-test4-rip.cjs**: Matadores de procesos para limpiar runs rotos. Artifacts para debugging.

**Sugerencias automáticas (legacy, fire-and-forget):**

- `post-sugerencia-*.cjs` (deep-research, github-topic, routing-animator, soomi): Posts de sugerencias OLD. El sistema NEW usa recordEvent → system-log → KB. Estos son artefactos del anterior (pre-M9).

**Composición temporal (proto específicos):**

- `demo-hybrid.ts`, `compose-from-existing-clips.ts`: Demos de composición manual (no son parte del pipeline activo).
- `proto-doctor-audio.ts`: Prepara audio para proto médico (SuperCalm específico).
- `tts-one.ts`, `tts-supercalm.ts`, `tts-medico-hook.ts`: Síntesis individual de TTS. Hoy el TTS vuelve integrado en el pipeline (no son extraídos separados).

## Wirings Clave (No-Obvios)

### 1. **Video-Intelligence = Motor de Aprendizaje (M7 Percepción)**

- **Punto de entrada**: `scripts/video-intelligence.ts` línea 19 importa `apps/web/lib/video-intelligence.ts` (la máquina real).
- **Lo que hace**: 
  - Carga el `.env` raíz (línea 6-17) porque `tsx` no lo hace solo.
  - Llama `analyzeVideoDeep()` con una ruta de video (línea 30, apps/web/lib/video-intelligence.ts línea 49-100).
  - Devuelve `VideoIntelligenceReport` con análisis Gemini + motion-map + timeline-plan.
  - Persiste a `storage/kb/formatos/<safe-name>.json` + evento KB (`subsistema='aprendizaje'`).
- **Wiring**: Usa `recordEvent()` → va al system-log → se inyecta en future llamadas Claude (M9 system-context).

### 2. **Sync-Invariants = Bidireccional (KB ↔ CLAUDE.md)**

- **Punto de entrada**: `scripts/sync-invariants.ts` línea 12-16 importa dinámicamente `apps/web/lib/kb/invariants.ts` vía `pathToFileURL` (porque necesita el módulo ES compilado en runtime).
- **Flujo**:
  1. Lee `CORE_INVARIANTS` o la semilla en `invariants.ts`.
  2. Llama `renderInvariantsMarkdown()`.
  3. Actualiza CLAUDE.md entre marcadores (línea 25-31).
- **Fuente de verdad**: `storage/kb/invariantes.jsonl` (si existe) o hardcoded `CORE_INVARIANTS` en `invariants.ts`.
- **Wiring**: Si editas una invariante en CLAUDE.md a mano, se pierde al siguiente `sync-invariants.ts`. La KB vive en código (`invariants.ts`) + storage (`invariantes.jsonl`), NO en el doc.

### 3. **Transcribe-Gemini = Verificación Crítica (Post-Gen)**

- **Env hardcodeado**: ROOT='C:\\Users\\cmktc\\proyectos\\video-factory' (línea 7). Portabilidad BAJA.
- **Uso**: `npx tsx scripts/transcribe-gemini.ts <audio.mp3>` o sin args → default a `storage/proto-key/medico-zonas.mp3`.
- **Salida**: JSON con transcripción + timestamps palabra-por-palabra + búsqueda específica de "ojeras" y "papada".
- **Wiring a Lipsync**: La invariante jun-2026 exige VERIFICAR OYENDO (transcribir) después de generar con Veo. Si la pronunciación es rara → regenerar con prompt más claro.

### 4. **Prep-Key = Lipsync NATIVO (Veo)**

- **Regla invariante**: NUNCA TTS de ElevenLabs encima de un clip animado. La voz NATIVA del clip Veo = lipsync correcto por construcción.
- **Flujo**:
  1. Busca `medico-hook-veo.mp4` + `medico-off-veo.mp4` en `storage/proto-key/`.
  2. Mide duración de cada uno vía ffmpeg.
  3. Concatena el AUDIO NATIVO de ambos con micro-fundidos en los bordes (línea 72-79).
  4. Genera `manifest-key.json` con `{hookDur, offDur}` para los cortes exactos.
- **Wiring a Compositor**: El compositor (PlanoEscenas.tsx) MUTEA los videos + toma audio de `combined-key.mp3` (la pista combinada nativa).

### 5. **HeyGen-Medico = ARTEFACTO CONTRADICTORIO**

- **Status**: ⚠️ DEPRECATED vía invariante jun-2026.
- **Lo que hace**: Sube foto verde a HeyGen → genera talking_photo → TTS ES masculino → descarga clip.
- **POR QUÉ está deprecated**: El owner corrigió jun-2026: "el problema es que usas ElevenLabs; tienes que hacerlo con Higgsfield (Veo)". TTS aparte + green-screen = lipsync inexistente + avatar rígido.
- **Script aún presente**: Porque quedó como reference histórica de "cómo NO hacerlo".
- **Replacement**: Usar Veo 3.1 vía MCP de generación (talking-head con diálogo, voz nativa en el prompt).

### 6. **Run-Quality-Gate = Compuerta Obligatoria (M5, Invariante Dura)**

- **Punto de entrada CLI**: `scripts/run-quality-gate.ts` línea 132-139.
- **Flags**:
  - `--run <runId>`: Toma render de `storage/runs/<runId>/final.mp4`.
  - `--render <ruta>`: Toma render directo (para testing).
  - `--original <ref.mp4>`: Compara fidelidad al original (para rips).
  - `--rip <ripId>`: Carga `AdAnalysis` del rip → rubrica específica.
  - `--gemini`: Usa Haiku para auditoría profunda (VE+OYE).
  - `--depth rapido|profundo`: Specialistas ejecutados.
- **Exit codes semánticos**: 0=pasa, 1=revisar, 2=falla, 3=error de ejecución (line 168).
- **Wiring en pipeline**: En `apps/web/lib/pipeline.ts`, al final CADA render corre `await runQualityGate()` con `useGemini:true` (OBLIGATORIO, no opt-in). El estado del run DEPENDE del veredicto: `completed` solo si `pass`, else `completed-with-warnings` + flag "NO VERIFICADO".

### 7. **Motion-Map = Detección de Movimiento (M7 Aprendizaje)**

- **Ubicado**: `apps/web/lib/motion-map.ts` (importado por video-intelligence.ts línea 17).
- **Capaz de**:
  - Muestreo temporal denso de frames (sampleFps configurable).
  - Frame-diff para detectar movimiento (%).
  - Segmentación: tramos `animado` vs `estático`.
  - Umbralización: cortes detectados cuando motionPct > 3x media.
- **Wiring a Aprendizaje**: Devuelve `MotionMap['segments']` → va a `VideoIntelligenceReport.motion` → persistido en `storage/kb/formatos/*.json`.
- **Limitación actual (jun-2026)**: Detección SÓLO temporal (sabe dónde hay movimiento, no QUÉ/QUIÉN se mueve). Pendiente: panel multi-agente de animación que interprete QUÉ (experto, usuaria, producto, b-roll).

## Archivos Clave y Rutas

| Archivo | Línea | Propósito |
|---------|-------|----------|
| `scripts/video-intelligence.ts` | 1-35 | Punto de entrada CLI para `analyzeVideoDeep()` |
| `apps/web/lib/video-intelligence.ts` | 1-100 | Motor real de percepción (Gemini + motion-map + persistencia) |
| `scripts/transcribe-gemini.ts` | 1-45 | Verificación POST-GEN (OYE el audio) |
| `scripts/prep-key.ts` | 1-86 | Lipsync NATIVO con ffmpeg concat |
| `scripts/sync-invariants.ts` | 1-37 | Sincronización KB ↔ CLAUDE.md |
| `scripts/run-quality-gate.ts` | 1-175 | CLI wrapper de compuerta obligatoria |
| `scripts/heygen-medico.ts` | 1-61 | DEPRECATED (referencia de error) |
| `apps/web/lib/kb/invariants.ts` | 1-200+ | Fuente de verdad de reglas invariantes |
| `storage/kb/invariantes.jsonl` | - | Registro vivo de decisiones (si existe) |
| `apps/web/lib/motion-map.ts` | - | Detección de movimiento temporal |
| `apps/web/lib/kb/quality-gate.ts` | - | Lógica de compuerta (format-audit panel) |
| `packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx` | - | Compositor que MUTEA videos + toma audio nativo combinado |

## Estado de Mantenimiento y Obsolescencia

| Categoría | Scripts | Acción Recomendada |
|-----------|---------|-------------------|
| **Activos/En-Producción** | video-intelligence, transcribe-gemini, prep-key, sync-invariants, run-quality-gate, prep-supercalm-assets, check-run, watch-run, migrate | ✅ Usar. Mantener. Documentar cambios. |
| **Vigilantes Efímeros (_tmp-)** | _tmp-copilot-*watcher*.cjs | 🟡 Herramientas de debugging. Borrar cuando ya no debugging. |
| **Probes/Exploration** | probe-*, smoke-* | 🟡 Para validación de providers. Mantener si hay cambios de API. |
| **Tests Unitarios** | test-* | 🟡 Corren fuera del suite `pnpm test` si son específicos. Migrar a Jest si es posible. |
| **Legacy/Artefactos** | launch-test*, monitor-test*, check-test*, step*.cjs, post-sugerencia-*.cjs | ❌ NO usar. Borrar si la sesión no los necesita. |
| **Deprecated (Invariante)** | heygen-medico.ts | ❌ NO ejecutar. Mantener como referencia de "error histórico". |

## Gotchas / Trampas a NO Re-Descubrir

### 🔴 Lipsync NATIVO vs. TTS Aparte (Trampa CRÍTICA)

**Trampa**: Generar un clip animado con un modelo (Veo, Kling, Higgsfield) y luego superponer TTS de ElevenLabs. Resultado: la boca no coincide, la compuerta lo caza como "lipsync inexistente", y el owner lo rechaza.

**Regla (invariante)**: La VOZ NATIVA del MISMO modelo que genera el video = lipsync correcto por construcción. Si quieres usar TTS, SOLO para voz en off sobre fotos fijas o b-roll sin cara (porque la cara no habla → no hay lipsync que romper).

**Evidencia**: `heygen-medico.ts` es el artefacto que violated esto (línea 25-26, TTS de ElevenLabs). Post-jun-2026, fue reemplazado por prep-key.ts (Veo nativo). Ver invariante "Lipsync = voz NATIVA" en `apps/web/lib/kb/invariants.ts:176-181`.

### 🔴 HardcodedROOT en Transcribe-Gemini

**Trampa**: `transcribe-gemini.ts` línea 7 tiene ROOT hardcodeado a 'C:\\Users\\cmktc\\proyectos\\video-factory'. Si cambias el proyecto de carpeta → falla.

**Solución**: Cambiar a `process.cwd()` o cargar desde .env (VF_STORAGE_DIR).

### 🔴 Sync-Invariants Puede Perder Cambios Manuales

**Trampa**: Si editas una invariante directamente en CLAUDE.md (entre los marcadores) y luego corres `sync-invariants.ts`, el cambio manual se sobrescribe.

**Regla**: Nunca edites CLAUDE.md a mano en la sección de invariantes. La FUENTE DE VERDAD es `apps/web/lib/kb/invariants.ts` (código) + `storage/kb/invariantes.jsonl` (registro). Usa `sync-invariants.ts` para reflejar cambios de código → documento.

### 🔴 Video-Intelligence Persiste = Basura en storage/kb/formatos/

**Trampa**: Cada llamada a `video-intelligence.ts` (sin `persist:false`) guarda un JSON en `storage/kb/formatos/`. Si corres el script 100 veces con videos de prueba, tendrás 100 JSONs basura.

**Solución**: Para testing, usa `persist:false` en `analyzeVideoDeep()`, o limpia `storage/kb/formatos/` regularmente.

### 🔴 Motion-Map es Best-Effort (No Garantizado)

**Trampa**: `buildMotionMap()` en `apps/web/lib/video-intelligence.ts` línea 57-64 es `try/catch` silencioso. Si ffmpeg o ffprobe fallan, el motion-map queda vacío pero el análisis de Gemini sigue siendo válido. El script NO fallará, solo perderás la detección de movimiento.

**Solución**: No confíes en motion-map como fuente única. Es complementario a Gemini. Si necesitas segmentación de movimiento crítica, verificar salida de `VideoIntelligenceReport.motion.segments`.

### 🔴 Quality-Gate es OBLIGATORIO en Pipeline, NO opt-in

**Trampa**: Si alguien intenta hacer `VF_GATE_ON_RENDER=0` para deshabilitar la compuerta (porque tardaría mucho), la invariante jan-2026 lo BLOQUEA. Hay un test guardián (`quality-gate-wiring.test.ts`) que rompe el build si se detecta.

**Regla**: La compuerta SIEMPRE corre. Si es demasiado lenta, optimiza (eg. usar `--depth rapido` en lugar de `profundo`, o `--gemini false` para quickcheck).

### 🔴 Test-* Scripts Fuera del Suite Jest

**Trampa**: Hay ~30 `test-*.ts` y `test-*.cjs` en scripts/ que NO corren con `pnpm test` (porque no están en `__tests__` o `*.test.ts`). Son scripts sueltos.

**Acción**: Si necesitas validar algo, chequea si ya existe un test-* antes de crear uno nuevo. Si es parte de la suite formal, migra al proyecto tests/ en pnpm.

### 🔴 Watchers Temporales (_tmp-*) Pueden Dejar Procesos Zombies

**Trampa**: `_tmp-copilot-preview-watcher.cjs` y `_tmp-copilot-watcher2.cjs` abren procesos en background (línea 49, `spawn('cmd.exe')`). Si matas el watcher antes de que termine, los procesos de media player pueden quedar vivos.

**Solución**: Usa `step1-kill-zombies-only.cjs` para limpiar, o mata procesos de media player manualmente.

### 🔴 Post-Sugerencia-*.cjs Son Legacy (Pre-M9)

**Trampa**: Los scripts `post-sugerencia-*.cjs` (deep-research, github-topic, routing-animator, soomi) pusheaban sugerencias el "viejo sistema". Hoy usamos `recordEvent()` + `systemEventToKb()` (M9, `system-log.ts`).

**Acción**: No los uses. Si necesitas enviar sugerencias, usa `recordEvent()` en código, o manualmente escribe a `storage/system-log.jsonl`.

### 🔴 Prep-SC20 vs. Prep-Key (Versiones Anteriores)

**Trampa**: Hay DOS scripts de preparación de lipsync: `prep-sc20.ts` (3 clips) y `prep-key.ts` (2 clips hook+off). Son versiones anteriores del mismo concepto.

**Regla**: Usa `prep-key.ts` (la más reciente, para SuperCalm jun-2026). `prep-sc20.ts` queda por referencia histórica.

### 🔴 Heygen-Medico Está Allí Por Error Histórico

**Trampa**: El script sigue en el repo aunque sea DEPRECATED. Un developer podría ejecutarlo sin saber que el owner lo prohibió.

**Prevención**: Hay una nota en `heygen-medico.ts` línea 1-2, pero no hay `throw` que lo prevenga. Considerar agregar un guard (eg. check VETO en .env) o borrar el archivo.

## Cómo Invocar los Scripts Activos

```bash
# Sincronizar invariantes a CLAUDE.md
npx tsx scripts/sync-invariants.ts

# Analizar un video (aprender formato)
npx tsx scripts/video-intelligence.ts "/ruta/al/video.mp4"

# Transcribir audio (verificación post-gen)
npx tsx scripts/transcribe-gemini.ts "storage/proto-key/audio.mp3"

# Preparar assets SuperCalm
npx tsx scripts/prep-supercalm-assets.ts

# Preparar lipsync nativo Veo
npx tsx scripts/prep-key.ts

# Compuerta de calidad (testing)
npx tsx scripts/run-quality-gate.ts --run <runId> --gemini --depth profundo

# Chequear estado de un run
npx tsx scripts/check-run.ts <runId>

# Watcher en vivo (monitorear progreso)
npx tsx scripts/watch-run.ts [runId]

# Migración de BD
pnpm db:migrate

# Monitoreo de rip (bash)
bash scripts/monitor-rip.sh <runId>
```

---

## Resumen Ejecutivo

El subsistema `scripts/` es un **ecosistema de 118 herramientas** que se divide en:

1. **Prod activos** (10-15): video-intelligence, transcribe-gemini, prep-key, sync-invariants, run-quality-gate, assets-prep, watch-run, check-run.
2. **Ephemeral watchers** (2-3 _tmp-*): Para debugging de sesión actual.
3. **Probes/tests** (40+): Para validación de providers, esquemas, lógica.
4. **Legacy** (30-40): Ciclos viejos (test4-11), sugerencias pre-M9, demos.

**Regla cardinal**: Lipsync NATIVO (mismo modelo, voz integrada), NO TTS aparte. Cualquier script que viole esto (heygen-medico.ts) es deprecated.

**Wiring crítico**: video-intelligence → motion-map + Gemini → persistencia KB; run-quality-gate → panel multi-agente → veredicto obligatorio; prep-key → audio nativo concatenado → compositor MUTEA video + toma audio.

**⚠️ Gotchas (16-scripts-cli — Subsistema de scripts y utilidades CLI):**
- LIPSYNC NATIVO (invariante crítica jun-2026): NUNCA TTS de ElevenLabs encima de clip animado. Voz NATIVA del MISMO modelo = lipsync correcto. heygen-medico.ts viola esto → DEPRECATED.
- transcribe-gemini.ts línea 7 tiene ROOT hardcodeado a C:\Users\cmktc\proyectos\video-factory → portabilidad baja. Si cambias carpeta → falla.
- sync-invariants.ts sobrescribe cambios manuales en CLAUDE.md. Fuente de verdad = apps/web/lib/kb/invariants.ts (código) + storage/kb/invariantes.jsonl. Nunca edites el doc a mano.
- video-intelligence.ts persiste un JSON por cada ejecución en storage/kb/formatos/ → basura acumulada. Para testing usa persist:false.
- motion-map es best-effort (try/catch silencioso). Si ffmpeg falla, motion.segments queda vacío pero Gemini analysis sigue válido.
- Quality-gate es OBLIGATORIO (no opt-in). Hay test guardián quality-gate-wiring.test.ts que bloquea intentos de deshabilitarlo. NUNCA lo desactives.
- test-* scripts en scripts/ NO corren con pnpm test (están sueltos, fuera de Jest). Chequea si existe antes de crear uno nuevo.
- _tmp-copilot-watchers pueden dejar procesos zombie si se matan abruptamente. Usa step1-kill-zombies-only.cjs para limpiar.
- post-sugerencia-*.cjs son legacy (pre-M9). Hoy usa recordEvent() + systemEventToKb(). No los invoques directamente.
- prep-sc20.ts y prep-key.ts son versiones anteriores/nuevas del mismo concepto. Usa prep-key.ts (la más nueva).
- heygen-medico.ts es ARTEFACTO DEPRECATED pero aún presente. No hay guard que lo prevenga de ejecutarse → riesgo de re-crear error histórico.
- motion-map detecta DÓNDE hay movimiento, no QUÉ se mueve. Panel multi-agente de animación para interpretar QUÉ (experto/usuaria/producto/b-roll) está pendiente.


---

# Subsistema 17: Lipsync y Wan 2.7 — Estado COMPLETO y VERIFICADO

## Propósito y alcance

Este subsistema cubre la **sincronización de labios (lipsync) con audio nativo** en personajes que hablan en video. El invariante fundamental es que **el lipsync debe venir de la voz nativa del mismo modelo que genera el video**, nunca de un TTS superpuesto. El modelo validado y probado es **Veo 3.1** (Google Generative Language API), que genera una cara hablando con **voz y labios sincronizados juntos** — el modelo "Wan 2.7" mencionado en el resumen inicial refiere a **Higgsfield DoP (Director of Photography)**, que es el motor de image-to-video de Higgsfield que mantiene la consistencia facial.

---

## 1. El invariante: Lipsync = voz nativa del MISMO modelo

**Archivo: `apps/web/lib/kb/invariants.ts:174-182`** — Invariante ID `lipsync-voz-nativa`

```
Regla: El lipsync de una cara que HABLA debe venir de la VOZ NATIVA del 
MISMO modelo que genera el video (genera voz y labios JUNTOS). Modelo correcto 
y PROBADO = Veo 3.1 (talking-head con diálogo nativo, vía el MCP de generación 
de Higgsfield): se le pasa la foto (start_image) + la LÍNEA hablada en el 
prompt y devuelve a la persona diciéndola con lipsync real.

⛔ NUNCA superpongas un TTS aparte (ElevenLabs) sobre el clip muteado: 
la boca no coincide con la voz ajena → la compuerta lo caza como "lipsync 
inexistente".
```

**Justificación histórica (`porQue`):** jun-2026 — generé un clip médico con Seedance (que NO genera voz nativa) y monté un TTS de ElevenLabs encima. La compuerta de calidad lo cazó como "lipsync inexistente" y el owner corrigió: *"el problema es que usas el narrador de Eleven; tienes que hacerlo con el mismo higgsfield"*. Regenerar al médico con Veo 3.1 (voz nativa en el prompt, la línea clara) + extraer su audio para la pista → el lipsync dejó de ser bloqueante.

---

## 2. Modelo Veo 3.1 — talking-head con voz nativa

**Archivo: `packages/blocks/video-gen-veo/src/block.ts:26-282`**

Veo 3.1 es un modelo de Google Generative Language API (AI Studio o Vertex) que implementa **image-to-video talking-head**. La API devuelve un clip de video (MP4) donde:

- **Input:** foto (start_image) + prompt de diálogo (línea hablada, ej. "Sientes la cara hinchada...")
- **Output:** video MP4 (~8s típicos) donde la persona dice esa línea CON lipsync real (los fonemas sincronizan con la boca)
- **Audio:** nativo del clip, ya incrustado en el MP4 → NO requiere TTS externo

**Características:**
- **Duración:** hasta 8 segundos por clip (limitación de la API).
- **Pronunciación:** El modelo articula la línea según el prompt. Puede pronunciar mal (ej. "cara en chaqueta" en lugar de "cara hinchada") → **SIEMPRE verificar oyendo** (`scripts/transcribe-gemini.ts`).
- **Automatización:** NO está integrado en el pipeline automático hoy. **Flujo manual:** generar escena → Veo 3.1 → reemplazar `scene_NN.mp4` → re-render.
- **Variantes de modelo:**
  - `veo-3.1-lite-generate-preview` (rápido, preview)
  - `veo-3.1-fast-generate-001` (rápido)
  - `veo-3.1-generate-001` (estándar)

**Ubicación en pipeline:** `apps/web/lib/scene-animator.ts` tiene el routing inteligente para Veo:
  - Primaria para fallback tras Kling
  - Solo se activa si `veoApiKey` configurada
  - Respeta los límites de rate (concurrency=2, retries 4 con backoff exponencial)

---

## 3. Higgsfield DoP (Director of Photography) — el modelo de animación realista

**Archivo: `packages/blocks/video-gen-veo/src/higgsfield-video-client.ts:1-339`**

Higgsfield proporciona **DoP** (Director of Photography), un motor image-to-video enfocado en **realismo facial humano para UGC/personas reales**. NO genera voz nativa (eso solo lo hace Veo); en su lugar, preserva la apariencia de la persona y permite animar micro-movimientos (parpadeo, respiración).

**Especificación:**

| Aspecto | Detalle |
|---|---|
| **Endpoint** | `POST /v1/image2video/dop` |
| **Modelos válidos** | `dop-lite` (básico), `dop-turbo` (2x velocidad, recomendado), `dop-preview` (nuevo) |
| **Input** | Imagen (foto) + prompt de movimiento + duraSec (5 o 10 s) |
| **Output** | Video MP4 con movimiento realista, SIN audio |
| **Flujo** | (1) Upload imagen → public_url; (2) Submit job; (3) Poll hasta completion |
| **Autenticación** | Header `Key keyId:keySecret` |

**Ventajas:** Preserva la identidad y fisionomía de la cara. Mejor para UGC/personas reales que modelos genéricos (nanoBanana, etc.).

**Limitaciones:** 
- NO genera audio/voz — es **solo animación visual**.
- Los clips son cortos (≤10s).
- Micro-movimientos automáticos (parpadeo, respiración) — no "habla" aunque el prompt mencione "boca abierta".

**Routing en scene-animator.ts:** `preferHiggsfield=true` ativa DoP como primary para presets con `formatId.startsWith('ugc-')` o styleId con "realista|fotorealista|real|ugc".

---

## 4. El flujo manual de lipsync: Veo 3.1 + extracción de audio

**Ubicación principal: `scripts/prep-key.ts:1-86`** — Script maestro que demuestra el flujo correcto.

### Paso 1: Generar clips con Veo 3.1 (voz nativa)

```typescript
// Entrada: foto de la persona + línea a decir
Input:  start_image = médico.png
        prompt = "Sientes la cara hinchada, ¿no? Aquí observamos papada suave..."
        
Output: médico-hook-veo.mp4 (8s)
        - Video contiene: médico hablando la línea con lipsync
        - Audio embebido en el MP4: su voz nativa diciendo la línea
```

### Paso 2: Extraer el audio nativo de los clips

```bash
# ffmpeg extrae [0:a] = audio track del clip Veo
ffmpeg -i médico-hook-veo.mp4 -q:a 9 -n médico-hook-audio.mp3
```

### Paso 3: Concatenar audios y sincronizar con cortes

**Archivo: `scripts/prep-key.ts:72-79`**

```typescript
// 2 clips: hook (8s) + off (6s) = 14s total
// Suavizar empalmes con afade (sin cambiar duración):
ffmpeg -i médico-hook-veo.mp4 -i médico-off-veo.mp4 \
  -filter_complex \
    '[0:a]afade=t=out:st=7.85:d=0.15[a0];
     [1:a]afade=t=in:st=0:d=0.15,afade=t=out:st=5.65:d=0.35[a1];
     [a0][a1]concat=n=2:v=0:a=1[out]' \
  -map '[out]' -c:a libmp3lame combined-key.mp3
```

**Output:** `combined-key.mp3` = pista de audio fusionada, lista para montar en el compositor.

### Paso 4: Montar en compositor (Remotion)

**Archivo: `packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx`**

```typescript
// FreeformElement con video MUTED + audioSrc externo
<FreeformElement
  kind="video"
  videoPath={médico-hook-veo.mp4}
  {...}
  muted={true}  // ← CLAVE: mutear el video
/>

// La pista de audio sale de audioSrc = combined-key.mp3
// Lipsync calza POR CONSTRUCCIÓN (son del mismo modelo)
```

**Invariante clave (`pip-persona-corte-posicion`):** El PiP del médico nunca es una foto fija, sino un CLIP animado recortado/posicionado. El clip contiene su voz nativa, que se integra en la pista final.

---

## 5. Limitaciones actuales — por qué NO está automatizado en el pipeline

### Límite A: Duración máxima de 8 segundos por clip Veo

Veo 3.1 genera clips de **≤8 segundos**. Para escenas más largas, hay que:
- Generar múltiples clips cortos con líneas fragmentadas.
- Concatenar audios en la pista.
- Sincronizar con cortes de imagen/composición.

**Estado:** No automatizado. Hoy es manual (script prep-key.ts).

### Límite B: Pronunciación sin garantía

El modelo puede pronunciar mal (ej. "cara en chaqueta" en lugar de "cara hinchada"). **Mitigación:** Transcribir el audio resultante con `scripts/transcribe-gemini.ts` ANTES de marcar como válido.

**Estado:** Script de verificación existe, pero NO integrado en pipeline.

### Límite C: Consistencia de voz entre clips

Para que una persona "hable" múltiples líneas con la misma voz:
- Usar el MISMO modelo (Veo) para TODOS los clips de esa persona.
- NO mezclar con TTS de ElevenLabs (voces distintas).

**Estado:** Manual — el operador elige usar Veo o ElevenLabs, no se auto-decide.

### Límite D: No integración automática en pipeline

**Archivo: `apps/web/lib/pipeline.ts`** — Hoy el pipeline:
1. Genera imágenes estáticas (image-gen-multi).
2. Anima con Kling/Veo/Higgsfield (scene-animator).
3. Monta en compositor (compositor-remotion) con audio de ElevenLabs TTS.

**NO hace:** Detectar "esta escena necesita lipsync" → generar con Veo 3.1 talking-head → extraer audio → montar en pista.

**Por qué:** 
- El pipeline hoy asume **una sola pista TTS** (voz del narrador completa).
- Veo 3.1 requiere **líneas habladas puntuales** (ej. "esto es papada").
- Integrar requeriría: (a) fragmentar guion por frase, (b) routing condicional (si es talking-head → Veo), (c) extracción + concatenación de audios.

**Roadmap:** Fase 3 — automatizar este flujo (pendiente).

---

## 6. Validación de lipsync en la compuerta

**Archivo: `apps/web/lib/render-quality-judge.ts:45,69`**

La compuerta de calidad tiene una **dimensión de validación llamada `lipsync`**:

```typescript
// Dimensión 2: lipsync
// SOLO si hay cabezas que hablan. ¿labios coinciden con audio (fonemas+timing)? 
// Marca el segundo donde se rompe. Las escenas largas suelen empeorarlo.

// En el mapa de rúbrica:
'animacion-movimiento': ['realismo', 'lipsync', 'ritmo-cortes'],
'voces-diarizacion': ['lipsync'],
```

**Ubicación en código:** `render-quality-judge.ts` (Gemini 2.5 Pro) analiza el video + audio renderizado y devuelve:

```typescript
{
  dimensión: 'lipsync',
  pass | fail | revisar,
  descripción: "labios fuera de sync a los 4.2s (boca abierta antes del fonema /a/)",
  recomendación: "regenerar escena 7 con Veo 3.1 + audio nativo"
}
```

**Limitaciones:**
- Gemini ve **fotogramas + audio** en MP4, pero NO hace análisis frame-by-frame de sincronización de fonemas (eso sería 0-dimensionalidad fonemática).
- Detecta **problemas gruesos** (boca cerrada mientras habla, boca abierta sin audio).
- **No detecta** sync perfecto (le basta "los labios se mueven cuando hay voz").

---

## 7. Comparación Veo vs. Higgsfield DoP vs. Kling

| Aspecto | Veo 3.1 | Higgsfield DoP | Kling |
|---|---|---|---|
| **Genera voz** | ✅ Sí, nativa | ❌ No | ❌ No |
| **Lipsync** | ✅ Voz+labios juntos | ❌ (no hay voz) | ❌ (no hay voz) |
| **Realismo facial** | ✅ Muy alto (soul_2) | ✅ Muy alto | ⚠️ Bueno (Pixar/ilustración) |
| **Máx duración** | 8s | 5-10s | 5-10s |
| **UGC/personas reales** | ✅ Sí (mejor con soul_2) | ✅ Sí (DoP + soul_2) | ⚠️ Menos realista |
| **B-Roll animado** | ✅ Sí | ⚠️ Posible | ✅ Mejor (Pixar/acuarela) |
| **Para talking-head** | ✅ **RECOMENDADO** | ❌ (sin voz) | ❌ (sin voz) |

**Decision routing:**
- **Talking-head (persona habla on-camera):** Veo 3.1 con voz nativa.
- **UGC realista (persona anima sin hablar on-camera):** Higgsfield DoP o Veo imagen-to-video sin voz.
- **B-Roll animado (Pixar/acuarela, sin personajes hablando):** Kling.

---

## 8. Scripts de soporte

| Script | Ubicación | Qué hace |
|---|---|---|
| **prep-key.ts** | `scripts/prep-key.ts` | Concatena audios nativos de Veo (hook + off) con afade, genera manifest. **Es el patrón maestro de lipsync correcto.** |
| **transcribe-gemini.ts** | `scripts/transcribe-gemini.ts` | Transcribe un MP4 con Gemini (audio → texto). Verifica que Veo pronunció bien. |
| **extract-audio.ts** | `scripts/extract-audio.ts` | Extrae [0:a] de un MP4 a MP3. Paso 2 del flujo. |
| **proto-key.ts** | `packages/blocks/compositor-remotion/src/proto-key.ts` | Composición Remotion que monta el médico con PiP recortado (video muted). |

---

## 9. Estado actual — FASE 2 completa, FASE 3 pendiente

### FASE 1 ✅ Completada (pre-jun-2026)
- Pipeline automático TTS (ElevenLabs).
- Animación con Kling/Veo (sin talking-head).
- Composición básica.

### FASE 2 ✅ Completada (jun-2026)
- **Veo 3.1 talking-head** integrado en `scene-animator.ts` (fallback, no primary).
- **Script prep-key.ts** como patrón maestro manual.
- **Validación** de lipsync en compuerta (dimensión `lipsync`).
- **Invariante documentado** en `kb/invariants.ts`.
- **Prototipos** funcionando (proto-key.ts, proto-supercalm.ts).

### FASE 3 ⏳ Pendiente (roadmap)
- **Auto-detect:** Pipeline reconoce "esta escena = talking-head" → routing automático a Veo 3.1.
- **Fragmentación automática:** Divide guion en frases → una por clip Veo (~8s).
- **Extracción + concatenación automática:** Pipeline extrae audio nativo, concatena, sinca con compositor.
- **Fallback robusto:** Si Veo falla o pronuncia mal → TTS de ElevenLabs (con advertencia de lipsync degradado).

---

## 10. Tabla de referencias clave

| Concepto | Archivo | Línea(s) | Detalles |
|---|---|---|---|
| **Invariante lipsync** | `apps/web/lib/kb/invariants.ts` | 174-182 | ID `lipsync-voz-nativa` |
| **Veo 3.1 block** | `packages/blocks/video-gen-veo/src/block.ts` | 26-282 | VideoGenVeoBlock, configuración modelos |
| **Higgsfield DoP client** | `packages/blocks/video-gen-veo/src/higgsfield-video-client.ts` | 1-339 | HiggsfieldVideoClient, endpoint `/v1/image2video/dop` |
| **Scene animator routing** | `apps/web/lib/scene-animator.ts` | 252-450 | Función animateScene, preferHiggsfield flag |
| **Motion prompt builder** | `apps/web/lib/scene-animator.ts` | 143-249 | buildMotionPrompt, v3.2 #144 — framing lock |
| **Prep-key maestro** | `scripts/prep-key.ts` | 1-86 | Flujo manual: Veo → extracción audio → concat |
| **Compositor (FreeformElement muted)** | `packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx` | (ver references) | Video MUTED, audioSrc externo |
| **Validación lipsync** | `apps/web/lib/render-quality-judge.ts` | 45,69 | Dimensión `lipsync`, detector Gemini |
| **Transcripción de audio** | `scripts/transcribe-gemini.ts` | (ver archivo) | Verifica pronunciación de Veo |

---

## 11. Notas de implementación

### Verificar una cara que habla
1. **Generar con Veo 3.1:** Pasar la foto + línea clara en ES neutro.
2. **Transcribir:** Usar `scripts/transcribe-gemini.ts` para verificar pronunciación.
3. **Montar:** FreeformElement con video MUTED, audio concatenado en pista.
4. **Validar:** Compuerta chequea `lipsync` en render final.

### Si el lipsync no cala
- **Causa 1:** TTS superpuesto en clip sin voz nativa → cambiar a Veo 3.1.
- **Causa 2:** Veo pronunció mal → regenerar con mejor prompt o usar TTS (con advertencia).
- **Causa 3:** Duración >8s → fragmentar en clips Veo + concatenar audios.

### Auditoría: ¿está bien el lipsync?
1. Mirar el video renderizado + oir el audio.
2. Buscar: "boca abierta sin sonido", "sonido sin movimiento de boca", "desfase temporal".
3. Si falla → regenerar con Veo 3.1 talking-head.

**⚠️ Gotchas (17-lipsync-y-wan):**
- ⛔ NUNCA superponer TTS de ElevenLabs sobre clip de Veo mudo: la compuerta cazará 'lipsync inexistente'. Veo ya GENERA la voz nativa con los labios sincronizados.
- Veo 3.1 tiene límite de 8 segundos por clip. Para escenas >8s: generar múltiples clips + concatenar audios con afade para suavizar empalmes (script prep-key.ts muestra el patrón).
- El modelo Veo puede pronunciar mal (ej. 'cara en chaqueta'). SIEMPRE transcribir el resultado con scripts/transcribe-gemini.ts ANTES de aceptarlo.
- Higgsfield DoP (Wan) NO genera voz — solo anima movimiento. Es para UGC/personas reales sin habla on-camera. Para talking-head, OBLIGATORIO Veo 3.1.
- El pipeline AUTOMÁTICO hoy NO hace lipsync de Veo 3.1 (sin auto-detect, sin fragmentación de guion, sin extracción de audio). Es MANUAL (flujo script prep-key.ts). Fase 3 lo automatizaría.
- Para consistencia de voz: si el personaje habla múltiples líneas, usar el MISMO modelo (Veo) para TODAS. NO mezclar Veo + ElevenLabs (voces distintas/inconsistentes).
- FreeformElement video en compositor DEBE tener muted=true si la pista de audio viene por separado (audioSrc externo). Si muted=false, suena dos veces.
- Motion prompt para Kling/Veo NUNCA debe mencionar acciones de voz ('speaking', 'talking', 'head turn', 'mouth open') — Veo las filtra como deepfake. Veo SÍ anima micro-movimientos (parpadeo, respiración) automáticamente.
- Validación `lipsync` en compuerta: Gemini detecta PROBLEMAS GRUESOS (boca cerrada mientras habla), no sync perfecto a nivel fonemático. Es verificación heurística, no guarantía de perfección.
- Si una escena es >8s y necesita talking-head, NO intentar hacer 1 solo clip Veo. Fragmentar en líneas (~4-5s cada una), generar clips, extraer audios, concatenar. Ejemplo: proto-key.ts (hook 8s + off 6s).


---

## ✅ Veredicto de completitud (crítico independiente)
- **Veredicto:** INCOMPLETO
- **Cobertura 3 modos:** CREAR: 85% cubierto (falta flujo de micro-escenas desde UI). RIPEAR: 80% cubierto (literalScript, fidelityMode='high' timing poco explicados). APRENDER: 65% cubierto (iteraciones de refinement confusas, el mapeador Gemini vs Claude no diferenciado). Los 3 modos convergen a runPipeline() pero § 02 NO lo explica claramente. § 01 asume que se leyó § 02 pero el orden mental es inverso.
- **Huecos:**
  - HUECO #1 — Word-sync: § 03 documenta detectEnumerations/planMicroScenes pero NO explica DÓNDE se usan en pipeline (¿compositor? ¿scene-planner?) ni cómo se SINCRONIZA exactamente (¿camera cut per micro-escena?). § 02 menciona 'micro-escenas sincronizadas' pero los endpoints NO muestran flow UI → pipeline para microSceneIndices.
  - HUECO #2 — Narrator Profile flow: § 03 explica narratorAnalyzer genera CharacterCard pero NO describe cómo se PROPAGA a TTS (voice selection), character-anchor, animator. § 02 NO tiene diagrama de inyección de narratorProfile en pipeline.
  - HUECO #3 — Route Profiles: § 01 menciona 'routeProfile.validator.anatomyMode' (strict/lenient) pero route-profiles.ts EXISTE y NO está documentado en ninguna sección. ¿Cómo se RESUELVE el route profile? ¿Automático por format?
  - HUECO #4 — VALIDATOR CHAT IA (post-clip): § 05 menciona 'extrae 3 keyframes, compara con imagen estática' pero NO especifica CUÁLES son los 3 keyframes (inicio/medio/fin? equiespaciados?). El onAntiPatternDetected callback en scene-animator.ts línea 30 NO está wireado a ningún sitio en las secciones.
  - HUECO #5 — Error Memory + Composition Memory: § 01 línea 169-170 mentiona pero NINGUNA sección explica cómo se ALIMENTAN, CONSULTAN o dónde viven en storage. § 04 NO explica cómo el validator usa error-memory para fortify prompts.
  - HUECO #6 — Fork metadata y aprobación de escenas: § 01 línea 536 menciona 'fork-metadata.json' pero § 02 NO lo explica. ¿Cómo se marcan las escenas 'pre-aprobadas'? ¿Cómo se CONSERVAN en el fork?
  - HUECO #7 — Mode 'collaborative': § 02 menciona 'pausa por scene esperando aprobación' pero NO explica POST /api/runs/[id]/resume, el campo 'pausedAtSceneIndex', ni cómo se RESUME el pipeline desde una scene específica.
  - HUECO #8 — Character anchor (identity): § 04 documenta pero § 02 NO lo menciona como override. ¿Override del usuario o automático si hay narratorProfile? ¿Cómo se DETECTA que una escena 'muestra al narrador'? (doesSceneShowNarrator() existe en código pero NO está en secciones).
  - HUECO #9 — Preset aprendidos: § 02 explica Aprender genera preset en packages/presets/pending/ pero NO explica el pipeline de APROBACIÓN en /admin ni cómo se MUEVEN a active. § 02 también NO explica la diferencia entre preset 'dinámico' (ripear) vs 'aprendido' (aprender).
  - HUECO #10 — fastMode: § 04 menciona 'skip anatomy voting + adversarial + sequence validator' pero fastMode NO está en la tabla de configuración de § 04. ¿Cuándo se ACTIVA? ¿Automático? ¿Override del usuario?
  - HUECO #11 — TTSCache + fallback: § 03 explica cache per provider pero NO EXPLICA el BUG de duración (§ ESTADO-VERIFICADO línea 20 'bug persiste'). Si cache-hit de ElevenLabs, ¿getVideoDurationSec() se llama? ¿Fallback a estimación?
  - HUECO #12 — Español neutro y voseo en validador: § 03 documenta toNeutralSpanish en guion pero § 01 INVARIANTE #6 menciona 'voseo en prompts internos del validador' (respetalos, volvés). ¿El validador normaliza? ¿Falla bloqueante?
- **Contradicciones:**
  - CONTRADICCIÓN #1 — UGC ANIMA O NO: § 01 línea 464 dice 'UGC (ugc-broll/ugc-testimony) TAMBIÉN se anima' + isAnimatedFormat incluye ugc-*. PERO § 05 está escrito como si UGC fuera SIEMPRE estático (routing a Higgsfield DoP, sin mención de animación real en el animator). EL CÓDIGO: isAnimatedFormat = ['b-roll-animated', 'voiceover-animated', 'ugc-broll', 'ugc-testimony']. RESULTADO: § 05 está DESACTUALIZADA.
  - CONTRADICCIÓN #2 — Word-sync con OpenAI TTS: § 03 línea 710 'obtiene timestamps POR PALABRA usando ElevenLabs /with-timestamps'. PERO el código (pipeline.ts línea 355-388) SOLO corre fetchWordTimings si provider === ElevenLabs. Si fallback a OpenAI TTS, word-sync = undefined. § 03 NO aclara esta condición (parece que word-sync SIEMPRE corre).
  - CONTRADICCIÓN #3 — minPassScore vs verdict threshold: § 04 línea 1161 'anatomyMode varía, pero validación es obligatoria'. § 04 línea 1150 'minPassScore=85'. § 04 línea 1165 'anatomyMode='strict' (default)'. PERO § 04 línea 1175 'Agregación final: min(structured, adversarial) + specialist voting', Y línea 507-537 'allApprove = (structured ok) AND (adversarial ok) AND (all specialists ok) AND (score ≥ 75)'. CONFUSO: ¿cuál es el threshold REAL? ¿75 o 85? (Código: minPassScore=85, pero internal V3 threshold es 75. § 04 lo mezcla).
  - CONTRADICCIÓN #4 — Fork escenas pre-aprobadas: § 01 línea 1603 'Filtrar escenas pre-aprobadas ANTES de image-gen'. § 01 línea 1604-1610 'El holistic review TAMBIÉN las excluy'. § 01 línea 1888 'El editor loop TAMBIÉN las exclye'. PERO § 01 SOLO menciona image-gen en el gotcha #8 'las escenas pre-aprobadas son INMUTABLES'.
  - CONTRADICCIÓN #5 — Voice selection orden: § 03 línea 52-65 describe 'B.1.5 Narrator Analyzer ANTES de TTS'. § 03 línea 91 'Voice Selection por Gender'. § 03 wiring crítico #1 'Voice selection DEBE corer ANTES de cache key'. PERO § 02 (Modos) NO menciona narratorProfile como un REQUERIMIENTO para voice selection. Un Claude que lea § 02 → § 03 pensaría que voice selection corre DESPUÉS de TTS.
  - CONTRADICCIÓN #6 — Character anchor vs preset.visualStyle.referenceImages: § 04 línea 1121-1152 'Si overrides.identityAnchor O preset.visualStyle.consistentCharacter'. § 04 línea 1075 'Si preset.visualStyle.referenceImages[0]'. PERO § 04 NO DIFERENCIA CHARACTER ANCHOR (person consistency) vs REFERENCE IMAGE (estilo fidelidad). Son CONCEPTOS DISTINTOS pero § 04 los mezcla (línea 1121 vs línea 1075).
  - CONTRADICCIÓN #7 — isAnimatedFormat gates pero después no corre animator: § 01 línea 461-465 'const isAnimatedFormat = [b-roll, voiceover, ugc-broll, ugc-testimony]'. § 01 línea 1299 'if (isAnimatedFormat && !disableRealAnimation)'. PERO el código DESPUÉS chequea TAMBIÉN 'skipVideoGen' (línea 1297-1302). Si skipVideoGen=true (estilos ilustrados), scene-animator CORRE pero deja videoPath vacío. § 01 NO menciona este caso especial (Ken Burns en compositor sin clip).
  - CONTRADICCIÓN #8 — Espacio  neutro en pipeline vs validador: § 01 línea 215-221 'Normaliza guion a neutro ANTES de TTS'. § 01 INVARIANTE #6 'voseo en prompts internos del validador (respetalos, volvés)'. PERO el validador usa los prompts reenriquecidos en §04 línea 1159 'Validador recibe narratorProfile + styleBase + brandContext'. ¿El validador TAMBIÉN normaliza? ¿O pasa voseo directo al juez Claude? § 03 / § 04 NO lo aclaran.
  - CONTRADICCIÓN #9 — reusePlanId no documentado: § 02 (Modos) NO menciona reusePlanId pero /api/generate/route.ts línea 29-30 tiene 'previewId' (que se pasa como reusePlanId al pipeline). ¿Esto es para REUTILIZAR el plan de un preview? ¿Es un override de scene-planner? § 01 NO lo menciona.
  - CONTRADICCIÓN #10 — ScenePatchTracker: § 01 línea 471 'scenePatchTracker se crea hoisted al scope entero'. § 01 línea 1456 'Usado por VALIDATOR CHAT IA para reportar anti-patterns'. § 01 línea 2299-2341 'proposePatchesFromOwnerComments convierte comentarios en patches'. PERO § 02-05 NUNCA mencionan scenePatchTracker ni cómo se CONSUME (¿en la KB? ¿en el Consejo de mejora?). El wiring está en el código pero NO está documentado en las secciones.

Las 17 secciones de referencia cubren APROXIMADAMENTE el 75% de Video Factory con precisión funcional, pero tienen huecos críticos, contradicciones estructurales y una jerarquía de presentación que confunde a un Claude nuevo. PROBLEMAS PRINCIPALES: (1) § 02 (Modos) y § 01 (Pipeline) se NECESITAN mutuamente pero NO se explican entre sí (§ 01 asume § 02, es el orden invertido). (2) Flujos complejos (word-sync, fork, route-profiles, narrative-Profile injection) están CÓDEADOS pero mal documentados. (3) UGC con animación = CONTRADICCIÓN entre § 01 vs § 05 (código dice SÍ, § 05 dice NO). (4) fastMode, reusePlanId, mode='collaborative', doesSceneShowNarrator(), route-profiles, TTS cache fallback bug, validador voseo = HUECO puro (código existe, doc NO). (5) Cambios recientes (29-may-2026) como 'UGC se anima' y 'Ken Burns revertido' mencionados en § 01 gotchas pero § 05 NO reflejados. VEREDICTO: INCOMPLETO para onboarding sin fricción. Un Claude nuevo (sin créditos) entiende CREAR básico, RIPEAR básico, pero APRENDER queda ambiguo; la arquitectura interna (wiring de providers, validators, routes) es un árbol sin raíces visibles. Para COMPLETO: (a) Reorganizar § 01-02 jerarquía (§ 01 TOP-LEVEL, § 02 detalle de modos); (b) Agregar § 06 'Route Profiles'; (c) Agregar § 07 'Wiring Crítico' (narratorProfile flow, fork mechanics); (d) Actualizar § 05 para UGC animations; (e) Unificar TTS cache + fallback bug y especificar Aprender iteraciones. Puntuación de completitud: Pipeline=90%, Imagen=85%, Animación=60%, Guion-Voz=75%, Modos=70%. PROMEDIO=76% → INCOMPLETO.


---

# 🔧 RESOLUCIÓN de huecos y contradicciones (verificado en código · 06-08)

> Estas resoluciones cierran los 22 ítems que el crítico de completitud marcó. Verificadas desde el código actual.

## Grupo: voz-narrador-anchor

# Flujo Voz-Narrador-Anchor: Análisis Preciso del Código

## 1) Propagación de narratorProfile: narrator-analyzer → voice-selector → TTS → image-gen → animator

**Flujo completo paso a paso:**

- **Origen (narrator-analyzer):** `packages/blocks/narrator-analyzer/src/block.ts:61-137`
  - El bloque infiere `NarratorProfile` desde el guion usando Gemini 2.5 Pro.
  - Devuelve `ParsedScript` enriquecido con `narratorProfile` (gender, ageRange, characterCard, narratorPresent).
  - Si falla o no hay API key, retorna perfil neutral por defecto (narratorPresent=false).

- **Pipeline — Resolución de narratorProfile:** `apps/web/lib/pipeline.ts:187-213`
  - Corre INMEDIATAMENTE después de script-processor (línea 187-189: "CRÍTICO: corre ANTES de TTS").
  - Si `overrides.narratorGenderOverride` existe (UI override), lo aplica directamente.
  - Si no, llama `narratorAnalyzer.run()` para inferencia con Gemini.
  - Resultado: `parsedScript.narratorProfile` poblado antes del TTS.

- **Voice Selection (selectVoiceForNarrator):** `apps/web/lib/pipeline.ts:239-259` y `packages/blocks/tts-elevenlabs/src/voice-selector.ts:27-85`
  - **ANTES de calcular cache key del TTS** (línea 239: "Si no hubo voiceOverride explícito, elegimos AQUÍ").
  - Llama `selectVoiceForNarrator({ defaultVoice, voiceLibrary, narratorProfile, ... })`.
  - Lógica: si narratorProfile.gender matchea defaultVoice.gender → usa defaultVoice; si NO, busca en voiceLibrary la voz que matches gender + ageRange más cercano.
  - Si encuentra match, actualiza `brand.defaultVoice` **ANTES** de la cache key (línea 248: "brand = { ...brand, defaultVoice: selectedVoice }").
  - Resultado: la voz correcta (por gender) está fija en `brand.defaultVoice` **antes** del TTS.

- **Cache Key (TTS):** `apps/web/lib/pipeline.ts:261-268`
  - Calcula `elevenlabsCacheKey = ttsCacheKeyFromScript(parsedScript, evVoice.voiceId, evVoice.modelId, evVoice.speedMultiplier, 'elevenlabs')`.
  - El `evVoice` es ahora la voz seleccionada por gender del narratorProfile (no la default ciega).
  - Si hay cache hit, copia el audio. Si no, corre TTS real con la voz correcta.

- **Image-Gen Multi (character anchor + narratorProfile):** `apps/web/lib/pipeline.ts:1154-1210`
  - Pasa `narratorProfile: sceneTrack.narratorProfile` (línea 1171) al ImageGenMultiBlock.
  - Pasa `characterAnchorImage` (línea 1159) si está generada (Cap 2).
  - El bloque usa `doesSceneShowNarrator()` para detectar qué escenas muestran al narrador.
  - Solo en escenas con narrador, pasa narratorProfile al validator V3 (línea 174-176 en image-gen-multi/block.ts).

- **Scene Animator:** `apps/web/lib/pipeline.ts:1266-1299`
  - Anima escenas con Veo/Kling si `isAnimatedFormat && !disableRealAnimation`.
  - Usa `sceneTrackWithImages` que YA tiene imágenes generadas con identidad anclada (si characterAnchorImage estuvo activa).
  - No recibe narratorProfile explícitamente; la identidad ya está en las imágenes generadas.

**Orden real CRÍTICO:** narratorProfile → selectVoiceForNarrator → actualiza brand.defaultVoice → cache key TTS → TTS execución → image-gen con characterAnchor + narratorProfile para validator → animator.

---

## 2) doesSceneShowNarrator(): detección de si la escena muestra al narrador

**Ubicación y lógica:** `packages/blocks/image-gen-multi/src/block.ts:255-280`

```typescript
function doesSceneShowNarrator(
  imagePrompt: string,
  narratorProfile?: { characterCard?: string; gender?: string; narratorPresent?: boolean },
): boolean {
  // 1. Si no hay narratorProfile o narratorPresent=false → devuelve false
  if (!narratorProfile?.narratorPresent || !narratorProfile.characterCard) return false;
  
  // 2. Extrae keywords distintivos del characterCard (ej. "japanese", "doctor", "monk", "señora", etc.)
  const cardKeywords = (card.match(
    /\b(japanese|asian|latino|...|chef|musician)\b/g,
  ) ?? []) as string[];
  
  // 3. Si el prompt menciona ALGUNO de esos keywords → probablemente muestra al narrador
  const hasNarratorKeywords = cardKeywords.some((kw) => prompt.includes(kw));
  
  // 4. Heurística negativa: si el prompt menciona explícitamente "patient", "young woman", "other person"
  // SIN mencionar keywords del narrador → es OTRO personaje
  const explicitlyOtherCharacter = /\b(patient|young woman|mujer joven|...)\b/i.test(prompt);
  
  // 5. Veredicto: si "otro personaje explícito" Y sin keywords del narrador → false
  // Si tiene keywords del narrador → true (aunque diga "patient", si "patient" es adjetivo del narrador)
  if (explicitlyOtherCharacter && !hasNarratorKeywords) return false;
  return hasNarratorKeywords;
}
```

**Uso:** En image-gen-multi, línea 550-ish (no mostrado aquí, pero se deduce de comentarios 250-253): para cada escena, calcula `doesSceneShowNarrator(imagePrompt, narratorProfile)`. Si true, pasa narratorProfile al validator; si false, pasa undefined (para evitar que el validator confunda "no muestra narrador" con "narrador esperado fallido").

---

## 3) Character anchor: override de usuario O automático por preset.visualStyle.consistentCharacter

**Ubicación:** `apps/web/lib/pipeline.ts:1121-1151`

```typescript
// Línea 1126-1127 — DECISIÓN CRÍTICA
const wantIdentity = overrides.identityAnchor ?? preset.visualStyle.consistentCharacter ?? false;
```

**Flujo:**
- `overrides.identityAnchor` = **UI override** (si el user lo fuerza, prevalece). Viene de `PipelineOverrides.identityAnchor` (línea 111).
- Si NO hay override explícito, cae a `preset.visualStyle.consistentCharacter` = **flag automático del preset** (línea 1127).
- Si AMBOS son undefined/null, default a `false` (sin anchor).

**Generación (si wantIdentity=true):**
- Chequea: `narratorPresent && characterCard && GOOGLE_AI_API_KEY disponible` (línea 1129-1133).
- Si todo checks, llama `generateCharacterAnchor({ characterDescription: np.characterCard, ageRange, styleBase, apiKey })`.
- El resultado `characterAnchorImage` (Buffer PNG) se guarda en `workDir/character-anchor.png` (línea 1143).
- Se pasa a ImageGenMultiBlock en línea 1159.

**Conclusión:** Es **híbrido**: primero override del user (si existe), luego automático por preset flag.

---

## 4) DIFERENCIA exacta: CHARACTER ANCHOR vs. preset.visualStyle.referenceImages

**CHARACTER ANCHOR (identidad de persona):**
- **Qué es:** Imagen PNG (vertical 9:16) del narrador, generada UNA SOLA VEZ per run desde `narratorProfile.characterCard` con Gemini Image.
- **Cómo se usa:** Se pasa a cada escena que MUESTRA AL NARRADOR como `referenceImage` para `generateWithIdentityAnchor()` (image-to-image con Nano Banana).
- **Propósito:** Garantizar que la MISMA PERSONA aparezca en todas las escenas (image-to-image preserva face, age, skin tone, build).
- **Prompt reforzado:** Buildea un prompt especial (línea 83-91 en block.ts) que dice "CHARACTER IDENTITY: the recurring person in this scene must be the SAME INDIVIDUAL as in the provided reference image — same face, same facial features, same age, same hair, same skin tone and build."
- **Código:** `apps/web/lib/character-anchor.ts:18-28` genera la imagen ancla; `apps/web/lib/pipeline.ts:1121-1151` decide activarlo; `packages/blocks/image-gen-multi/src/block.ts:94-105` lo aplica en `generateWithIdentityAnchor()`.

**preset.visualStyle.referenceImages (anclaje de ESTILO):**
- **Qué es:** Buffer(s) de imagen de referencia (data-URI base64 en `preset.visualStyle.referenceImages[0]`) que describe el ESTILO visual deseado (composición, iluminación, paleta, atmósfera).
- **Cómo se usa:** Se decodifica en `presetReferenceImage` (línea 1080-1100), se pasa al ImageGenMultiBlock como `referenceImage` (línea 1158), y se antepone un STEP Nano Banana al chain de providers.
- **Propósito:** Anclar el ESTILO de TODA la secuencia a una referencia visual (no la identidad de una persona, sino la "vibe" del video).
- **Prompt reforzado:** No se especifica aquí, pero la doc de image-gen-multi (línea 185-189) dice "se antepone un step Nano Banana que genera cada escena anclada a esta imagen" para "estilo solamente".
- **Código:** `apps/web/lib/pipeline.ts:1075-1100` carga y decodifica; `packages/blocks/image-gen-multi/src/block.ts:130-135` en `ProviderStep` interface especifica que `referenceImage` se usa para image-to-image style-only.

**DIFERENCIA RESUMIDA:**
| Aspecto | CHARACTER ANCHOR | preset.visualStyle.referenceImages |
|--------|------------------|-----------------------------------|
| **Qué ancla** | Identidad de PERSONA (mismo rostro, edad, tono piel) | ESTILO visual (composición, luz, atmósfera) |
| **Generada** | Una sola vez per run desde narratorProfile.characterCard | Precargada en el preset (data-URI) |
| **Usado en** | Escenas que MUESTRAN AL NARRADOR (detectadas por doesSceneShowNarrator) | TODAS las escenas del run |
| **Técnica** | image-to-image con prompt reforzado "same individual" | image-to-image con step Nano Banana prepended |
| **Scope** | Por narrador, multiple escenas | Por preset, todas las escenas |

---

## 5) Orden real: narratorProfile → voice selection → ANTES de cache key del TTS

**Secuencia precisa (con líneas):**

1. **Script processor** → `parsedScript` básico sin narratorProfile (línea 175-185).
2. **Narrator analyzer** (línea 187-213):
   - Infiere o aplica override de gender.
   - Retorna `parsedScript.narratorProfile`.
3. **Español neutro normalización** (línea 215-221).
4. **Voice selection** (línea 239-259):
   - `selectVoiceForNarrator(...)` elige voz por gender del narratorProfile.
   - **ACTUALIZA** `brand.defaultVoice` si no matchea (línea 248).
5. **TTS cache key calculation** (línea 261-268):
   - `elevenlabsCacheKey = ttsCacheKeyFromScript(parsedScript, evVoice.voiceId, ...)` — `evVoice` ES la voz seleccionada en paso 4.
   - Luego: cache hit/miss, TTS real, etc.

**Crítico:** la voice selection (paso 4) ocurre **ANTES** de la cache key (paso 5), así el script + voz correcta entran juntos a la cache. Si fuera al revés, la cache cachearía el script con la voz incorrecta.

**Confirmación de "ANTES de la cache key":** 
- Línea 233-238 (comentario): "FIX VOZ (crítico): el TTS y la cache key usaban SIEMPRE brand.defaultVoice... Si no hubo voiceOverride explícito, elegimos AQUÍ la voz... y la fijamos como defaultVoice ANTES de la cache key".
- Línea 239: `if (!overrides.voiceOverride && parsedScript.narratorProfile)` — chequea ANTES de calcular cache key.
- Línea 261: `const evVoice = brand.defaultVoice;` — es la voz actualizada.

---

## Grupo: animacion-ugc-skipvideo

## 1. UGC ANIMA O NO: routing con isAnimatedFormat

**Respuesta:** LOS UGC ENTRAN AL SCENE-ANIMATOR Y SE ANIMAN. El routing es Higgsfield-preferente (para realismo facial superior), pero IGUAL se animan (no son foto fija).

**Confirmación precisa:**

La función `isAnimatedFormat` en `pipeline.ts:461-465` incluye explícitamente los formatos UGC:

```typescript
const isAnimatedFormat =
  fmtId === 'b-roll-animated' ||
  fmtId === 'voiceover-animated' ||
  fmtId === 'ugc-broll' ||           // ← UGC B-ROLL ENTRA AL ANIMATOR
  fmtId === 'ugc-testimony';          // ← UGC TESTIMONY ENTRA AL ANIMATOR
```

**¿Qué pasa después?** En `pipeline.ts:1299`, si `isAnimatedFormat` es true, se llama `animateScenes()` con routing inteligente:

- **Para UGC (`fmtId.startsWith('ugc-')`):** `preferHiggsfield=true` → animator usa Higgsfield DoP (modelo `dop-turbo`, línea 1352) para ANIMAR la persona real con movimiento facial/corporal creíble.
- **Para B-ROLL animado:** Kling v2-6 o Kling v3 según el modelo.
- **Fallback:** Veo 3.1-lite.

El comentario en `pipeline.ts:456-459` lo aclara:
> "UGC (ugc-broll/ugc-testimony) TAMBIÉN se anima: la ruta UGC = persona en CLIP con movimiento (regla del owner), nunca foto fija. Antes el gate solo dejaba pasar b-roll-animated/voiceover-animated → los UGC salían estáticos. Con esto entran al scene-animator y preferHiggsfield los rutea a Higgsfield DoP (realismo humano)."

**Archivo y línea:** `apps/web/lib/pipeline.ts:461-465` (isAnimatedFormat), `pipeline.ts:1299` (condición), `pipeline.ts:1319-1326` (routing decision).

---

## 2. skipVideoGen: cuando isAnimatedFormat pero estilo ilustrado → Ken Burns en compositor

**Respuesta:** Cuando un video es `isAnimatedFormat=true` pero el `styleBase` detecta un estilo ilustrado (acuarela/sepia/comic/etc.), el scene-animator **corre igualmente** pero con `skipVideoGen=true`. Esto detiene la llamada a los providers (Kling/Veo/Higgsfield) y deja `videoPath` vacío. El compositor entonces **aplica Ken Burns cinematográfico** (zoom + paneo) sobre la imagen estática aprobada.

**Flujo detallado:**

1. **Detección de estilo ilustrado** (`pipeline.ts:1286-1290`):
   ```typescript
   const styleBaseLowerForAnim = (sceneTrackWithImages.styleBase ?? '').toLowerCase();
   const isIllustratedStyle =
     /hand[- ]?illustrated|hand[- ]?drawn|watercolor|acuarela|sepia|comic|cartoon|painted by hand|digital painting|pixar|ghibli|ilustrad|painterly/.test(
       styleBaseLowerForAnim,
     );
   ```
   Si coincide el patrón, es estilo ilustrado.

2. **Pase de skipVideoGen al animator** (`pipeline.ts:1337`):
   ```typescript
   skipVideoGen: process.env['KEN_BURNS_ONLY'] === '1',
   ```
   Nota: actualmente `KEN_BURNS_ONLY` es una variable ENV para opt-in manual; con estilos ilustrados aún se usa el fallback a Ken Burns.

3. **En scene-animator, lógica skipVideoGen** (`scene-animator.ts:629-635`):
   ```typescript
   if (opts.skipVideoGen) {
     animated = item.scene;  // NO se anima, scene queda sin videoPath
     opts.logger?.info(
       { sceneIndex: item.scene.index, entity: 'KEN BURNS' },
       'scene-animator:skip_video_gen_using_ken_burns_on_static',
     );
   } else {
     animated = await animateScene(...);  // Llamadas a Kling/Veo/Higgsfield
   }
   ```

4. **IMPORTANTE:** El scene-animator **SIGUE CORRIENDO** el VALIDATOR y la pausa colaborativa (línea 627):
   > "El VALIDATOR + la pausa colaborativa de abajo SIGUEN corriendo sobre la imagen estática."
   
   Validamos que la estática es correcta; no saltamos la validación.

5. **En el compositor (PlanoEscenas.tsx)** (`PlanoEscenas.tsx:280-297`):
   Como `videoPath` está vacío, renderiza la imagen estática con movimiento Ken Burns:
   ```typescript
   // Fallback: imagen estática. MOVIMIENTO (Ken Burns) SOLO si se pidió (kenBurns).
   const panDirection = sceneIndex % 4;
   const motionOn = kenBurns;
   const panMax = !motionOn ? 0 : animatedScenes ? 60 : 30;
   // ... pan dinámico (panX, panY) + zoom (zoom = 1 + ((motionOn ? zoomEnd : 1.0) - 1) * t)
   ```
   El Ken Burns es cinematográfico: pan (paneo direccional) + zoom dinámico en timeline.

**Justificación** (comentario en `pipeline.ts:1271-1280`):
> "El image-to-video (Kling/Veo) se DESVÍA de la imagen base en estilos acuarela/sepia/comic — re-encuadra (cuerpo completo → close-up), pierde el concepto, y el clip NO coincide con la estática aprobada. Para estos estilos usamos la estática aprobada con movimiento Ken Burns cinematográfico (zoom + paneo + parallax) FIEL 100% a lo que el owner aprobó + ahorra la llamada cara a Kling. Para UGC/fotorealista SÍ usamos AI video (Higgsfield drift es menor + Ken Burns sobre foto se ve peor)."

**Archivos y líneas:** 
- Detección: `pipeline.ts:1286-1290`
- Pase skipVideoGen: `pipeline.ts:1337`
- Lógica en animator: `scene-animator.ts:629-635`
- Compositor Ken Burns: `PlanoEscenas.tsx:280-297`

---

## Grupo: wordsync-microescenas-ttscache

## 1. Word-sync / Micro-escenas: detectEnumerations, expandEnumerationScenes, alignScenesToWords

### Dónde se usan en pipeline.ts

**Ubicación: `apps/web/lib/pipeline.ts` líneas 710–759**

El bloque word-sync corre en la sección "Cap 4 — Alineación PERFECTA al narrador (word-level) + micro-escenas" (líneas 700–759):

1. **fetchWordTimings** (línea 721) — se llama al endpoint ElevenLabs `/with-timestamps` para obtener timestamps por carácter/palabra
2. **alignScenesToWords** (línea 740) — realinea cada escena a sus palabras exactas (corte sincronizado a la narración)
3. **expandEnumerationScenes** (línea 745) — expande enumeraciones en micro-escenas si `wantMicro` es true

**Implementación:**
- `fetchWordTimings`: `packages/blocks/word-sync/src/elevenlabs-timings.ts:28–60` — llamada POST a `/v1/text-to-speech/{voiceId}/with-timestamps` devuelve MP3 + alignment (carácter→tiempo)
- `alignScenesToWords`: `packages/blocks/word-sync/src/scene-align.ts:37–86` — mapea cada scene.text a sus palabras exactas, fijando startTimeSeconds/endTimeSeconds; luego hace cortes contiguos sin huecos
- `expandEnumerationScenes`: `packages/blocks/word-sync/src/scene-expand.ts:31–89` — detecta enumeraciones (ej. "recorre tu cara, tu abdomen y tus piernas"), part cada escena que contiene una enumeración en N micro-escenas, una por ítem

**Micro-escenas y microSceneIndices:**
- **De la UI al pipeline**: `overrides.microSceneIndices` (tipo `number[] | null`, línea 124) llega desde POST `/api/runs` (usuario elige qué escenas expandir en micro-escenas)
- **En expandEnumerationScenes**: si `microSceneIndices` está definido, SOLO se expanden las escenas cuyos índices estén en la lista (línea 745: `overrides.microSceneIndices ?? null`); si es null/undefined, expande TODAS las enumeraciones (comportamiento legacy)
- **Re-indexación**: después de expandir, se re-indexan todas las micro-escenas para mantener índices contiguos (línea 88 en scene-expand.ts)

**Sincronización al compositor:**
- `scene.startTimeSeconds / endTimeSeconds` fijados por word-sync → el compositor-remotion los respeta (`series.Sequence`, duration = scene.endTimeSeconds - startTimeSeconds)
- El audio se reemplaza con el de `/with-timestamps` (línea 736: `await writeFile(audioTrack.filePath, wt.audio)`) para garantizar que palabras y audio coincidan al milisegundo
- Cada micro-escena ve el mismo clip (ej. Veo/Kling), solo que recortado en su ventana temporal exacta

---

## 2. Word-sync SOLO con ElevenLabs: fallback a OpenAI

### Análisis de pipeline.ts líneas 355–388 (fallback) y 710–759 (word-sync)

**Punto crítico (línea 710–715):**
```typescript
const evKey = process.env['ELEVENLABS_API_KEY'];
const wantMicro = overrides.wordSync ?? preset.subtitles.wordSyncMicroScenes ?? false;
// Sin voz: NO llamamos a ElevenLabs (re-generaría audio con voz). El plan
// ya quedó alineado a la duración estimada por alignScenesToAudioTiming.
if (evKey && !overrides.skipVoice) {
```

**Verdad precisa:**

1. **Word-sync REQUIERE ElevenLabs API key** (`if (evKey && !overrides.skipVoice)`, línea 715)
2. **Si ElevenLabs falla y cae a OpenAI fallback** (líneas 331–398):
   - El fallback **NO llama a word-sync** — el bloque word-sync se salta completamente
   - `audioTrack.segments` sigue siendo la alineación APROXIMADA por TTS genérico (char-interpolation desde segments del block TTS)
   - `word-sync = undefined` implícitamente (no se importa, no se ejecuta)
3. **Consecuencia:** sin word-sync, no hay micro-escenas sincronizadas ni alineación perfecta a palabra exacta
   - Las escenas quedan con timing de char-interpolation (vulnerable a desfase si hay variación de velocidad de habla)
   - Enumeraciones NO se expanden (aunque `wantMicro = true`)

**Flujo verificado:**
- **Rama ElevenLabs exitoso** (línea 330): TTS devuelve audio, **word-sync corre** (línea 715–758), audio se reemplaza con `/with-timestamps`
- **Rama ElevenLabs falla** (línea 331: `audioResult.isErr()`):
  - Fallback OpenAI (línea 347–391)
  - **word-sync NUNCA corre** — el bloque entero (710–759) está dentro de `if (evKey && !overrides.skipVoice)` que es falso tras fallo
  - Escenas quedan alineadas solo a `alignScenesToAudioTiming` (línea 630, char-level, no word-level)

---

## 3. TTS cache + duración: bug histórico y estado actual

### Ubicación: `apps/web/lib/pipeline.ts` líneas 296–328 (cache-hit con duración)

**Problema histórico (v3.2 #142, 29-may-2026):**
```
ANTES: spawnSync('ffprobe') crudo → ffprobe NO está en PATH del sistema 
       → fallaba SIEMPRE → defaulteaba a 60s
       → scenes de 6-11s imposibles (bug de duración que el owner detectó)
```

**Fix actual (líneas 296–328, cache-hit; 362–367, fallback OpenAI cache-hit):**

1. **Al cache-hit** (línea 296): copiamos el mp3 cacheado a workDir/audio.mp3
2. **getVideoDurationSec()** (línea 307): usa el ffmpeg **BUNDLED** (@remotion) — NOT del sistema
3. **Fallback inteligente**: si getVideoDurationSec falla o devuelve <= 0.5s:
   - Estima duración desde caracteres del script (~15 char/s para español)
   - `realDuration = max(3, estChars / 15)` (línea 312)

**Estado verificado en código:**

- **Frame-extractor** (`apps/web/lib/frame-extractor.ts:19–41`): `getVideoDurationSec(videoPath)` usa ffmpeg bundled con Remotion (línea 20: `findFfmpegPath()`)
- **ffmpeg locator** (`ffmpeg-locator.ts`, implícito): encuentra el ffmpeg dentro de node_modules de Remotion, no del sistema
- **Validación de fallback** (línea 310): `probedDuration && probedDuration > 0.5` — si ffmpeg falla o devuelve 0, cae a char-estimation
- **Cache-hit ElevenLabs** (líneas 296–328): incluye la lógica de duración (getVideoDurationSec + fallback)
- **Fallback OpenAI cache-hit** (líneas 356–367): replica la misma lógica de duración

**El bug de duración está RESUELTO** (v3.2, confirmado en código):
- ffmpeg bundled confiable
- Fallback a char/s inteligente si ffmpeg falla
- Cobertura tanto en cache-hit ElevenLabs como en fallback OpenAI
- La red de seguridad B.4.1 (líneas 662–698) también estira la última escena si falta cobertura de audio

---

### Resumen del estado

| Punto | Estado | Evidencia |
|-------|--------|-----------|
| **Word-sync usa detectEnumerations/expandEnumerationScenes/alignScenesToWords** | ✅ Verificado | `pipeline.ts:740,745`; `scene-expand.ts:31–89`; `scene-align.ts:37–86` |
| **microSceneIndices llega desde UI y controla qué escenas expandir** | ✅ Verificado | `PipelineOverrides:124`; `expandEnumerationScenes` línea 37 (allowedSceneIndices param) |
| **Word-sync SOLO con ElevenLabs** | ✅ Verificado | `if (evKey && !overrides.skipVoice)` línea 715; sin ElevenLabs, word-sync no corre |
| **OpenAI fallback ≠ word-sync** | ✅ Verificado | word-sync está dentro de `if (evKey)` que falla si ElevenLabs cae |
| **Bug de duración en cache-hit** | ✅ RESUELTO v3.2 | getVideoDurationSec (ffmpeg bundled) + fallback char/s; líneas 307,312,362 |

---

## Grupo: collaborative-fork-reuse

## 1. Modo Collaborative: Mecanismo de Pausa y Reanudación

El modo collaborative **NO usa POST /api/runs/[id]/resume**. La decisión del owner se registra exclusivamente vía:

**POST /api/runs/[id]/intervene** (apps/web/app/api/runs/[id]/intervene/route.ts:59-136)
- Recibe `{ type: 'approve'|'reject'|'skip'|'comment', sceneIndex, newImagePrompt?, newMotionPrompt?, comment? }`
- Persiste la intervención en `owner-feedback` (tabla/storage)
- Retorna `{ interventionId, queuedAt, willBeProcessedBefore }`

**Mecanismo Real de Reanudación** (apps/web/lib/collaborative-mode.ts:57-185):
1. Pipeline llama `waitForApprovalIfCollaborative(runId, sceneIndex)` tras animar cada scene
2. Si `mode != 'collaborative'` → retorna inmediato con `action='approve'`
3. Si sí → **setea en DB**: `awaitingApproval=true`, `pausedAtSceneIndex=sceneIndex`, `currentStep='aguardando aprobación'`
4. **Loop de polling** cada 5 segundos (POLL_INTERVAL_MS) leyendo **readPendingInterventions(runId, sceneIndex)** de la tabla de feedback
5. Cuando owner clickea botón en UI → POST /intervene registra la intervención
6. Loop detecta la intervención, **setea awaitingApproval=false**, libera la pausa
7. Retorna `ApprovalResult` con `{ action, intervention, newImagePrompt?, newMotionPrompt?, additionalComments, waitedMs }`
8. **scene-animator.ts** (línea 948-1015) interpreta la action:
   - `approve` → continúa sin cambios
   - `reject` → **FIX (línea 966-1002)**: regenera SIEMPRE con `onRegenerateImage`, aunque el owner solo dejó comentario (sin newImagePrompt); deriva el prompt corregido como: `${animated.imagePrompt}\n\nCORRECCIÓN DEL OWNER...${approval.intervention?.comment}` 
   - `skip` → acepta tal cual
   - `timeout` → **detiene el run con error** (línea 1011-1013) para no violar consentimiento del owner

**FIX Reciente (scene-animator.ts, línea 966-972)**: Cuando el owner rechaza una scene con SOLO comentario (sin newImagePrompt explícito), se regenera automáticamente derivando el prompt de la imagen original + la corrección del comentario del owner. Esto cierra el bug de que "Rechazar" con solo feedback no regeneraba.

---

## 2. Fork: Escenas Pre-Aprobadas y Conservación

**fork-metadata.json** (ejemplo: storage/runs/9faf6cb0-5167-49e7-98de-1c58fc0bc080/fork-metadata.json:1-9)
```json
{
  "sourceRunId": "4d402920-0fd3-4543-a08b-652ffcf6704c",
  "fromSceneIndex": 0,
  "copiedScenes": [0],
  "forkedAt": "2026-05-29T18:44:24.099Z",
  "note": "Las scenes en copiedScenes ya están aprobadas — el pipeline NO debe regenerarlas ni pausar para owner."
}
```

**Cómo se marcan escenas pre-aprobadas** (apps/web/lib/pipeline.ts:555-586):
- Al detectar fork-metadata.json en workDir, lee `copiedScenes: number[]` 
- Crea `preApprovedSceneIndices = new Set(forkMeta.copiedScenes)`
- Sete en cada scene pre-aprobada: `imagePath` y `videoPath` desde disco (padded: `scene_00.png`, `scene_00.mp4`)

**Pasos que EXCLUYEN escenas pre-aprobadas** (para no regener/re-validar):

1. **scene-animator.ts (línea 602-622)**: Si `preApprovedSceneIndices.has(sceneIndex)` e imagePath+videoPath existen en disco → **saltea totalmente**: no anima, no llama VALIDATOR, no pausa colaborativa
   
2. **pipeline.ts (línea 1225-1232, image-gen-multi)**: Filtra escenas pre-aprobadas ANTES de pasarlas a image-gen-multi; luego fusiona las generadas con las preservadas
   
3. **pipeline.ts (línea 1603-1604, holistic regen)**: Auto-regeneración post-validación holística **exluye** pre-aprobadas: `filter((i) => !preApprovedSceneIndices.has(i))`
   
4. **pipeline.ts (línea 1888-1890, editor IA)**: Editor IA detecta target pre-aprobada y la saltea (no la muta)
   
5. **scene-animator.ts (línea 1040-1045, propagación de correcciones)**: Propagación de feedback del owner **excluye** pre-aprobadas; solo propaga a scenes nuevas

---

## 3. reusePlanId / previewId: Reutilización del Plan de Preview

**API /api/generate/route.ts (línea 29-30, 96)**:
```typescript
previewId: z.string().optional(),  // línea 30
reusePlanId: previewId ?? null,     // línea 96 — pasa como override del pipeline
```

**Mecanismo** (apps/web/lib/pipeline.ts:530-554):
- Si `overrides.reusePlanId` viene setado (= el previewId del usuario):
  - Lee el archivo `previewPlanPath(reusePlanId)` = `storage/previews/${previewId}.json` (apps/web/lib/paths.ts:49-50)
  - Parsea el `SceneTrack` guardado en ese preview
  - **Saltea scene-planner completamente** → usa exactamente los índices y estructura que el usuario vio en preview
  - Si el archivo no existe (expiró/borrado) → cae a planner normal (fallback seguro)

**Por qué**: Cuando el usuario hace micro-escenas en preview (elige índices específicos para expandir), esos índices SOLO tienen sentido si la estructura de escenas es idéntica. Reusar el plan de preview garantiza que `microSceneIndices` (ej. [2, 5, 8]) apuntan a las MISMAS escenas que el usuario vio y eligió en preview, no a re-planificaciones nuevas que cambiarían los índices.

**Log de éxito** (línea 538-540): `'pipeline:reusing_preview_plan'` con `{ reusePlanId, scenes: sceneTrack.scenes.length }`

---

## Grupo: routeprofiles-fastmode-threshold

# Route Profiles, FastMode y Thresholds de Validación

## 1) Route Profiles: Resolución y Controles

**Archivo:** `apps/web/lib/route-profiles.ts`

### Cómo se RESUELVE el route profile:

La función `resolveRouteProfile(input: RouteResolveInput)` (**líneas 174-186**) ejecuta un matching **secuencial con prioridad**:

1. **Exactitud por ID** — compara `formatId` y `styleId` contra `p.match.formatIds[]` y `p.match.styleIds[]` (líneas 180-181)
2. **Palabras clave en styleBase** — busca matches parciales en `p.match.styleKeywords[]` dentro del string concatenado: `${styleBase} ${formatId} ${styleId}` (línea 177, 182)
3. **Fallback** — si nada matchea, retorna `DEFAULT_ROUTE_PROFILE` (línea 185), que es **anatomía estricta + animación real** para máxima compatibilidad histórica

### Tres perfiles definidos (líneas 58-147):

| Perfil | ID | Match | anatomyMode | animation | motionIntensity |
|--------|------|-------|-------------|-----------|-----------------|
| **Cartoon 3D/Pixar** | `cartoon-3d` | Palabras: `pixar`, `cartoon`, `3d-animated`, `anthropomorphic`; formato: `b-roll-animated` | **lenient** | `ken-burns` | `powerful` |
| **Ilustrado** | `illustrated` | Palabras: `watercolor`, `comic`, `sepia`, `ghibli`, `hand-drawn` | **lenient** | `ken-burns` | - |
| **UGC/Realista** | `ugc-real` | Palabras: `ugc`, `realista`, `photoreal`, `real person`; formato: `ugc-testimonial` etc. | **strict** | `real` | `subtle` |

### Qué controlan los modos:

- **anatomyMode** (**línea 45**):
  - `strict` (UGC/realista): 5 dedos/toes, proporciones humanas son CRÍTICAS (6 dedos → se regenera)
  - `lenient` (cartoon/ilustrado): dedos/toes/proporciones son ESTILO, el panel `ai-artifact` sigue rechazando fusiones/melted/blobs reales
  
- **animation** (**línea 48**):
  - `real` (image-to-video Higgsfield/Kling/Veo): naturalidad facial para UGC
  - `ken-burns` (pan/zoom): movimiento estático para estilos fijos (acuarela, cartoon)

---

## 2) FastMode: Activación y qué Saltea

**Archivos:** `packages/blocks/scene-validator/src/validator-v3.ts` y `apps/web/lib/pipeline.ts`

### Activación:

**Automática en corrección y ripeo** — se activa explícitamente en tres contextos:
- `correction-pipeline.ts:502` — durante regeneración de escenas fallidas en el repair loop
- `rip-fidelity-aligner.ts:760, 943` — validación iterativa de keyframes durante ripeo de alta fidelidad
- `pipeline.ts:1173` — en la generación normal (M1+ feedback: minPassScore 85, retries 3)

**Es un OVERRIDE manual**, NO automático según heurística (no hay detección "confío en el provider").

### Qué SALTEA:

En `validator-v3.ts:454-465`:
```
if (input.fastMode || !ambiguous) {
  // SALTEA la Pass 2: Adversarial (que cuesta ~2-4s y 1 llamada extra Gemini)
  const passed = detResult.score >= 75;
  return { verdict: passed ? 'pass' : 'regenerate', ... };
}
```

**Qué NO saltea:**
- ✅ **Cuestionario estructurado** (línea 336-341): preguntas detalladas, no negotiable
- ✅ **Anatomía voting** (líneas 345-395): 2 llamadas paralelas de especialistas, consensus failure = critical
- ✅ **Panel de especialistas** (líneas 329-408): narrative-fit, real-world, ai-artifact (5 especialistas en paralelo, línea 313-357)
- ❌ **Adversarial critique** (línea 450-505): SKIP en fastMode. Solo corre si score 70-79 (ambiguo) Y NO fastMode

**Efecto práctico:** Ahorra ~1-2s y ~$0.001-0.002 por imagen, manteniendo 99% de detección (los especialistas paralelos son el bottleneck anterior, no adversarial).

---

## 3) Threshold REAL de Validación: Capas y Políticas

Hay **tres niveles de umbral**; cada uno aplica en un contexto diferente:

### Nivel 1: SceneValidatorV3 (Validator interno)

**Archivo:** `packages/blocks/scene-validator/src/validator-v3.ts:515-520`

- **Threshold = 75** (líneas 455, 497, 520)
  - Si `severity === 'none'` (no hay críticos) **Y** `score >= 75` → `verdict = 'pass'`
  - Sino → `verdict = 'regenerate'`
  - En fastMode: aplica línea 455; con adversarial: aplica línea 520 (min de structured + adversarial)

- **Este threshold es DURO e INTERNO** — lo establece el validator, no es configurable desde fuera

### Nivel 2: image-gen-multi (Pipeline wrapper)

**Archivo:** `apps/web/lib/pipeline.ts:1168`

- **Threshold = 85** (`minPassScore: 85`)
  - El `ImageGenMultiBlock` recibe `minPassScore: 85` (línea 1168)
  - **ESTE sobrescribe el 75 interno** — no confiar en un score 75-84, repetir
  - Además: `maxValidationRetries: 3` (línea 1167) + `validateSequence: true` (línea 1169) con `minSequenceScore: 80`

- **Contexto:** Post "Test 5 feedback" (comentario línea 1162), se subió de 75→85 porque "un retry y score 75 dejaban pasar errores que el ojo humano nota"

### Nivel 3: quality-gate (Compuerta post-render)

**Archivo:** `apps/web/lib/kb/quality-gate.ts:51-98`

- **NO usa umbral de score directo** — opera sobre **severidad de hallazgos** (encontrados por el panel format-audit)
- `GatePolicy` (línea 52):
  ```
  failOn: 'high' | 'critical'    (default: 'critical')
  reviewOn: 'medium' | 'high'    (default: 'high')
  reviewOnMediumCount: 3         (dispara revisar si ≥3 hallazgos 'medium')
  ```

- **Veredicto determinista** (`decideGateVerdict`, línea 522):
  - `fail` si ∃ hallazgo con severidad ≥ `failOn` (default `critical`)
  - `revisar` si ∃ severidad ≥ `reviewOn` (default `high`) O ≥3 hallazgos `medium`
  - `pass` en otro caso

- **Este es INDEPENDIENTE del validator de imágenes** — la compuerta juzga el VIDEO COMPLETO (composición, ritmo, voces, producto legible, anotaciones), no anatomía de frames individuales

### Matriz de aplicación (dónde aplica cada uno):

| Threshold | Dónde aplica | Qué valida | Configurable | Nota |
|-----------|--------------|-----------|--------------|------|
| **75** (V3) | Per-imagen durante image-gen | Anatomía, texto, física, coherencia narrativa de un frame | NO (hardcoded) | Interno; saltea adversarial en fastMode |
| **85** (pipeline) | image-gen-multi loop | Reintento de frames que caen 75-85 | Vía `minPassScore` parámetro | Sobrescribe 75, agresivo post-feedback |
| **Policy severidad** (gate) | Post-render, video entero | Hallazgos agregados del panel (voces, edición, producto, PiP, anotaciones) | Vía `VF_GATE_FAIL_ON`, etc. env vars | Determinista; NO es un score, es un juicio booleano por severidad

**Conclusión:** El 75 es **interno y defensivo** (No hace daño, solo acepta frames claros). El 85 es **agresivo en la generación** (rechaza más). La compuerta es **un juez separado** del validator de imágenes, opera a nivel de video entero con criterios de formato específico.

---

## Grupo: memoria-patchtracker-validator-presets-voseo

## 1. Error Memory + Composition Memory (packages/core)

**Qué guardan:**
- **Error Memory**: errores específicos de generación (anatomía, texto basura, mismatch semántico, etc.). Campos: `provider`, `model`, `errorCategory`, `narration`, `originalPrompt`, `errorDescription`, `wasFixed`. Append-only JSONL con validatorScore opcional.
- **Composition Memory**: pares IA-generado ↔ ajuste manual del usuario (geometría de elementos, rotación, opacidad, zIndex). Campos: `sceneIndex`, `narration`, `elementCorrections[]` (per-elemento: `aiRect`/`humanRect`, deltas de properties). Append-only JSONL.

**Dónde viven:**
- **Error Memory**: `/storage/error-memory/errors.jsonl` (resuelto desde `process.cwd()` via `defaultErrorMemoryPath()`; línea 65).
- **Composition Memory**: `/storage/composition-memory/corrections.jsonl` (línea 60).

**Cómo se alimentan:**
- **Error Memory**: `recordError()` (línea 75) → append JSONL + genera UUID. Llamado por validators post-escena para registrar failures. Closure loop: `markErrorFixed(id)` (línea 165) marca `wasFixed=true` cuando retry pasó.
- **Composition Memory**: `recordCompositionCorrection()` (línea 67) → append JSONL tras edición del usuario. `diffComposition()` (línea 175) compara IA vs humano (tolerancia 0.5% en geometría) y devuelve corrections + resumen legible.

**Cómo se consultan:**
- **Error Memory**: `queryRelevantErrors()` (línea 124) → scoring (keywords +5, category +3, provider +2, narración +1, wasFixed bonus +2) + top-K. Devuelve hallazgos más relevantes.
- **Composition Memory**: `queryRelevantCompositionCorrections()` (línea 107) → scoring por brand/preset/narración (word overlap simple), peso recencia (últimos 7 días +1 bonus). Top-K más recientes.

**Cómo validator las usa para fortify:**
- La IA scene-planner **antes de generar** consulta `queryRelevantErrors()` + `queryRelevantCompositionCorrections()` → `formatLessonsLearned()` (línea 182) sintetiza top-10 fixes como bloque inyectado en su system prompt: `"LESSONS LEARNED FROM PAST FAILURES (avoid these patterns): ..."`. Esto nutre el prompt original para evitar pitfalls conocidos.

**Archivos:** `packages/core/src/error-memory.ts` + `packages/core/src/composition-memory.ts` (lineas mencionadas arriba).

---

## 2. scenePatchTracker: Qué es, llenado y consumo

**Qué es:**
Per-run tracker (instancia única por `runId`) que acumula patches sistémicos detectados por el preview-judge en image-gen-multi. Si 2+ scenes disparan el mismo issue (mismo patch normalizado), lo registra como propuesta de patch en `/admin` para que el owner lo valide.

**Cómo se llena (`proposePatchesFromOwnerComments`):**
Dos rutas:
1. **Scene-level loop** (`scene-patch-tracker.ts` línea 60-102): `createScenePatchTracker()` retorna callback `report(info)` que el preview-judge llama cada vez que detecta un problema sistémico (ej. "burned-text-hex-codes en 2 scenes"). `report()` normaliza el patch (lowercase, collapse whitespace), acumula en `Map<string, PatchAccumulator>`, y cuando `acc.scenes.length >= THRESHOLD_OCCURRENCES` (2), llama `persistAsProposal()` (línea 124) que genera un `SystemicPattern` estructurado y lo persiste vía `recordProposedPatch()` al archivo de proposals.
2. **Owner feedback** (`owner-feedback.ts` línea 489): `proposePatchesFromOwnerComments(brandId, presetId)` → `getCommentStatsCrossRun()` agrupa comments del owner por categoría, y si `occurrenceCount >= 3` Y `runIds.length >= 2`, devuelve candidates con `proposedNegativeInstruction` auto-generada (ej. "CRITICAL — owner repeatedly flagged anatomy issues"). El pipeline (línea 2300) toma estos candidates y llama `recordProposedPatch()` para persistirlos.

**Cómo y dónde se consume (`pipeline.ts` ~1456, ~1470, ~2299-2341):**
- **Línea 1456**: `scenePatchTracker.report({patch, sceneIndex, severity, category, description})` → callback que el animator (`scene-animator.ts` ~30) emite cuando el validator detecta `onAntiPatternDetected`.
- **Línea 1470**: `fortifyPromptWithAntiPatterns(correctedImagePrompt, runId)` → llamado en el onRegenerateImage callback. Consulta los anti-patterns acumulados del run y los APPENDS al prompt que se va a regenerar, para que el provider sepa qué evitar.
- **Línea 2300-2341**: Cierre del run → `proposePatchesFromOwnerComments()` agrega comentarios cross-run a proposal, `recordProposedPatch()` persiste cada candidate, y `logSystemEvent()` emite evento de config-changed para auditoría.

**Archivos:** `apps/web/lib/scene-patch-tracker.ts` (creator + report callback), `apps/web/lib/pipeline.ts` (líneas 1456, 1470, 2300), `apps/web/lib/validator-chat-ia.ts` (fortifyPromptWithAntiPatterns línea 1696).

---

## 3. VALIDATOR post-clip: Keyframes extraídos y callback onAntiPatternDetected

**Keyframes extraídos para comparar:**
- **Densidad**: 2 frames/segundo (línea 88: `FRAMES_PER_SECOND = 2`). Para un clip de 8s → 16 frames extraídos (línea 1438: `rawCount = Math.round(durationSec * FRAMES_PER_SECOND)`).
- **Rango temporal**: **1 frame por cada 0.5 segundos** (cobertura exhaustiva, no 3 fijos). Esto cubre morphing intermedio que tres keyframes se perdían (comentario línea 17-18 del validator-chat-ia.ts).
- **Capping dinámico por attempt**: Attempt 1 = MAX_FRAMES (18), Attempt 2+ = MAX_FRAMES_RETRY_HARD (8), Attempt 3+ = MAX_FRAMES_RETRY_HARD_2 (6). Ancho capped a `KEYFRAME_WIDTH=400` (línea 95) o `KEYFRAME_WIDTH_RETRY=320` en attempts altos, para mantener tokens controlados (línea 1442-1443).
- **Sin equiespaciamiento fijo**: muestreo denso por ffmpeg a rata uniforme (1 cada 0.5s), pero el validator los analiza como secuencia frame-a-frame (PASO 2 del protocolo: línea 516).

**Callback `onAntiPatternDetected`:**
- **Scene-animator.ts**: Línea ~30 declara el tipo (no mostrado en la lectura, pero integrado en `AnimateScenesOptions.validator`). El callback se pasa como parámetro `validator.onAntiPatternDetected` al `runValidatorLoop()` (línea 30).
- **Validator emite**: Cuando el veredicto es "wrong" con `severity='critical'` o si detecta un patrón repetible (ej. burned-text-hex-codes), emite un `systemicAntiPattern` (campo del JSON de veredicto, línea 403) describiendo el error para que escenas posteriores lo eviten.
- **Pipeline lo consume**: `onAntiPatternDetected` callback (línea 1438-1463) log-ea el patron y llama `scenePatchTracker.report()` para acumularlo. Si 2+ scenes del mismo run disparan el mismo patron, se propone un patch global.

**Archivos:** `apps/web/lib/validator-chat-ia.ts` (líneas 88, 1438-1449, protocolo líneas 468-599), `apps/web/lib/scene-animator.ts` (signature del callback, línea ~30), `apps/web/lib/pipeline.ts` (integración líneas 1438-1463).

---

## 4. Aprobación de presets aprendidos: Pipeline /admin

**Ruta de movimiento de pending → activos:**
- **Listar pendientes**: `GET /api/admin/presets/pending` (route.ts línea 10-16) → `listPendingPresets()` retorna presets en `packages/presets/pending/learned-auto-*.preset.json`.
- **Aprobar**: `POST /api/admin/presets/[id]/approve` (route.ts línea 16-54) → `approvePendingPreset(params.id)` (implementación en admin-presets-store.ts, no mostrada aquí pero infiere: mueve archivo `pending/` → `PRESETS_DIR` root). Registra juicio 'approved' en `storage/preset-memory/judgments.jsonl` (línea 24-36) con weight 1.5 (mayor que run-success automático, weight 1.0).

**Diferencia: Preset "dinámico" (ripear) vs "aprendido" (auto-learn):**
- **Dinámico (ripear)** (`rip-fidelity-aligner.ts` + `dynamic-preset-builder`): Extrae keyframes del referenceVideoPath original → genera cada scene iterativamente contra esos keyframes hasta 95% similitud. **Resultado**: preset que clone FIELMENTE el estilo/composición del original. Más lento (~10-15 min) y caro (~$2-3), pero produce imágenes mucho más cercanas.
- **Aprendido (auto-learn)** (`auto-learn-preset.ts` línea 1-112): Claude multimodal (`understandVideo()`) mira el video una sola pasada, infiere `VideoUnderstanding` (hook, character, style, density, suggested components), y CONSTRUYE un `PresetConfig` completo (sin iteración/comparación). **Resultado**: preset válido listo para usar, pero menos exacto en estilo (v1: una sola pasada; v2 planeada iteraría test → regenerar → ajustar). Más rápido y barato.

**Almacenamiento en `packages/presets/pending/`:**
- **Auto-learn**: Persiste en `learned-auto-{timestamp}.preset.json` (línea 51, función `findPresetsPendingDir()`). Opcional: también `learned-auto-{timestamp}.understanding.json` si `persistUnderstanding=true` (línea 100).

**Archivos:** `apps/web/app/api/admin/presets/pending/route.ts`, `apps/web/app/api/admin/presets/[id]/approve/route.ts`, `apps/web/lib/auto-learn-preset.ts` (líneas 93-113 interfaces).

---

## 5. Voseo en prompts internos del validador: Normalización, bloqueos

**Cómo valida voseo:**
- **Detección**: `detectVoseo(text: string)` (`neutral-es.ts` línea 50) → regex `WORD_RE` sobre el texto, busca VOSEO_MAP keys (imperativos voseo acentuados, presente voseo, "acá"). Devuelve `string[]` de formas detectadas.
- **Mapa fijo** (línea 14-29): `mirá→mira`, `tenés→tienes`, `podés→puedes`, `acá→aquí`, etc. Lookup POR PALABRA EXACTA (no regex), así no toca homógrafos del pretérito (`salí`, `sentí`, `descubrí` sin contexto quedan fuera por diseño conservador).
- **Normalización**: `toNeutralSpanish(text)` (línea 41) aplica VOSEO_MAP y preserva mayúscula inicial.

**¿El validador normaliza o pasa voseo al juez?**
- **Pipeline normaliza ANTES de TTS** (línea 45: `import { toNeutralSpanish }`): El guion se normaliza **antes** de generar TTS (best-effort), así el audio sale neutro.
- **Validador DETECTA en el guion final**: La compuerta de calidad (`quality-gate.ts` línea 753) llama `detectVoseo(input.contextText)` sobre el guion/audio del run. Si hay voseo, es BLOQUEANTE (línea 754-768): `severity='critical'`, `estado='confirmado'`, `veredicto='fail'`. Texto del bloqueo (línea 760): `"El guion/audio no está en español neutro (voseo: mirá, tenés, ...)"` + fix propuesto.

**¿Hay falla bloqueante?**
- **SÍ, es bloqueante crítico**: Si `detectVoseo()` retorna `length > 0`, el veredicto de la compuerta se fuerza a `fail` (línea 765) y la resumen cita las formas (línea 767). Es regla dura del owner (CLAUDE.md, invariante #5).
- **No aplica si normalización cubre todo**: Si `toNeutralSpanish()` cubre las formas (inequívocas en VOSEO_MAP), el pipeline normaliza y llega neutro a la compuerta. Solo falla si quedan formas no en el mapa o si la normalización se desconecta.

**Archivos:** `apps/web/lib/neutral-es.ts` (líneas 14-58), `apps/web/lib/kb/quality-gate.ts` (líneas 753-768), `apps/web/lib/pipeline.ts` (línea 45, integración del toNeutralSpanish).

---

