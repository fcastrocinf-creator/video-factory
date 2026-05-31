# HANDOFF — Video Factory · Orquestador de composición

> Documento de traspaso entre conversaciones de Claude Code.
> Para continuar: abre un chat nuevo en este proyecto y di **"lee HANDOFF.md y seguimos"**.
> Última actualización: 2026-05-30 (Versión 2).

---

## 🏁 VERSIÓN 3 — 30-05-2026 (5 capacidades cableadas al pipeline + e2e)

> El gran avance: convertir en **lógica del host** (no scripts manuales) las
> capacidades que antes hacía Claude a mano. Todas **opt-in** (un run normal
> queda byte-idéntico) y con **tests + FULL typecheck verde**.

**Capacidades cableadas al pipeline real:**
1. **Subtítulos ZapCap automáticos** (cap 5) — `pipeline.ts` tras el render: si
   `preset.subtitles.autoZapcap.enabled` (u override `subtitlesZapcap`) → quema
   subtítulos → `final-subtitled.mp4`. Best-effort.
2. **Edit/overlay (mixeo)** (cap 3) — `image-gen-multi`: si `scene.editStep`, tras
   la imagen base corre un EDIT Nano Banana (glow sobre el cuerpo). `buildEditPrompt`
   testeado. **PENDIENTE:** que el scene-planner EMITA `editStep` solo (hoy no lo hace).
3. **Ruteo por componente** (cap 1) — `scene-planner` deriva `componentType`
   (`deriveComponentType`, detecta ES+EN, excluye animados) + `image-gen-multi`
   `preferredProviderOrder` (reordena el chain por escena, preserva fallback).
4. **Identidad-anchor** (cap 2) — `pipeline.ts` genera 1 anchor del personaje
   (`character-anchor.ts`) si `consistentCharacter`; las escenas con
   `featuresCharacter` se generan ancladas a esa identidad. **PENDIENTE:** validator
   identity-pass (solo se cableó la generación).
5. **Micro-escenas word-synced** (cap 4) — block nuevo `@video-factory/block-word-sync`
   (`fetchWordTimings` + `planMicroScenes` + `expandEnumerationScenes`, 13 tests).
   `pipeline.ts` expande enumeraciones ("cara, abdomen y piernas") en micro-escenas
   con cortes por palabra. Opt-in `wordSyncMicroScenes`.

**Tests nuevos:** word-sync 13, image-gen-multi 10 (edit/identity/provider-order),
scene-planner 6 (component-type, infra creada). `pnpm -r typecheck` = verde.

**Prueba e2e (run `7c77b0ac`, preset `lodo_e2e_test`):** el host produjo **solo** un
video completo + subtítulos (`final-subtitled.mp4`) — sin un script de Claude.
Disparó cap 4 (micro-escenas), cap 2 (anchor generado) y cap 5 (auto-ZapCap).
**Cazó un bug** (componentType solo-inglés) → arreglado + test de regresión en español.
**Issues honestos del run:** animación 0/8 (quota Kling agotada — cuenta, no código);
artefactos de imagen que el validator SÍ detectó (manos/pies/reflejos); identidad no
aplicada en ESE run (usó la derivación pre-fix). Server nuevo corriendo en `:3001`.

**UPDATE (re-run `8bbee165`, con fixes):** ✅ **collage ELIMINADO** (regla "un solo
cuadro" en `scene-planner` systemInstruction + `singleFrameClause` en `image-gen-multi`
+ styleBase limpio). ✅ cap 1 componentType correcto (4 ugc + 3 cgi, ya no todo "other"
— fix del regex español en `deriveComponentType` + test de regresión). ✅ cap 2 identidad
APLICADA (~85%, pelo varía = límite Nano Banana). ✅ cap 4 micro-escenas. ✅ cap 5
auto-ZapCap (`subtitles-zapcap`). ✅ cap 3: planner ya **emite `editStep`** (autónomo),
pero no dispara si el guion no pide overlay (situacional).

**Ken Burns OPT-IN (fix):** el movimiento pan/zoom sobre imágenes estáticas ya NO es
automático (era `microMotion=true` por default en `PlanoEscenas` + el formato animado
forzándolo cuando la animación fallaba). Ahora **default = imagen FIJA**; el usuario lo
activa con el toggle **"Movimiento Ken Burns"** en el editor de composición. Flujo:
`CompositionEditor` (checkbox) → `POST /rerender {kenBurns}` → `rerenderComposition(id,{kenBurns})`
→ `RenderJob.kenBurns` → `PlanoEscenas`/`SceneFrame` (gate del pan/zoom). Validado: re-render
del run `8bbee165` quedó estático (frames de una misma escena idénticos).

**Alineación PERFECTA al narrador (fix crítico):** la alineación vieja
(`alignScenesToAudioTiming`, char-interpolation sobre segmentos TTS) desfasaba el visual
— una frase corta podía durar MÁS que una larga. Nuevo: `alignScenesToWords(scenes, words)`
en `@video-factory/block-word-sync` (4 tests) ancla cada escena a sus PALABRAS exactas
(timestamps ElevenLabs). Cableado en `pipeline.ts` (bloque cap-4): corre SIEMPRE que haya
ElevenLabs (ya no opt-in), reemplaza el audio por el de `/with-timestamps` (palabras y
audio coinciden), re-alinea, y si el preset lo pide expande micro-escenas. También parchea
`audioTrack.durationSeconds`. Validado: re-alineé el run `8bbee165` → s3 corta 4.4s→1.8s,
s4 larga 2.4s→3.0s (antes al revés). **Optimización pendiente:** que el TTS original use
`/with-timestamps` para no hacer 2 llamadas (hoy genera audio 2x).

**Pendientes V3:** (a) validar cap 3 en vivo con un guion que pida overlay; (b) lock de
identidad >85% (prompt más fuerte o avatar dedicado Higgsfield); (c) validator
identity-pass (cap 2); (d) **recargar quota Kling** (o habilitar Veo/Vertex video) para
animación — hoy 0/8 anima por quota de cuenta, no por código.

---

## 🏁 VERSIÓN 2 — 30-05-2026 (checkpoint, tag `v2-2026-05-30`)

> El gran avance de esta sesión: **codificar la RUTA para igualar un estilo de ad
> desde 0, rápido**. El valor de la herramienta no es un video puntual — es la
> velocidad para clavar visualmente cualquier estilo. Eso quedó en la lógica.

### Lo construido (todo con checkpoints locales, sin push a GitHub)
1. **Aprendizaje mejorado** (`image-gen-tools.ts`, `preset-learning-loop.ts`):
   generación con **imagen de referencia** (Nano Banana image-to-image) + selección
   del frame **representativo** (antes "el más limpio" → perdía densidad). 93 → 99.
2. **Referencia en creación** (`image-gen-multi/block.ts` + `pipeline.ts`): cuando el
   preset trae `referenceImages`, el bloque antepone un step Nano Banana que ancla el
   estilo. Gated por preset (los otros estilos no se tocan).
3. **Perfiles de ruta** (`route-profiles.ts`) — "acá es diferente" hecho datos:
   cartoon/ilustrado = anatomía **lenient** + motion **powerful**; UGC/real = **strict**
   + **subtle**; default = histórico. `resolveRouteProfile()`.
4. **Validator style-aware** (`scene-validator/validator-v3.ts`): `anatomyMode`. En
   `lenient` NO se rechaza por conteo de dedos/toes/proporciones (son estilo en cartoon).
   Default `strict` = comportamiento histórico. **Verificado: cartoon→0 rechazos anatómicos.**
5. **Arquitecto IA** (`/arquitecto`, contextType `architect` en `claude-chat-discuss.ts`):
   chat (Sonnet) que conoce pipeline + perfiles de ruta + cerebro, **propone cambios con
   tu OK** (nunca toca código solo).
6. **RUTA DE APRENDIZAJE CODIFICADA** (`auto-learn-preset.ts` + `video-understander.ts`):
   captura **densidad** (`compositionDensity` + `keyVisualComponents`) + **embebe una
   referencia representativa** en el preset (antes `referenceImages` quedaba VACÍO) +
   **enriquece el prompt** con la densidad. Doc: `investigacion/RUTA-IGUALAR-ESTILO.md`.
7. **Fix anti-texto** (`scene-planner/block.ts`): la **narración ya no se quema** en las
   escenas. Causa: la frase "NO text/NO captions/NO Spanish text..." (×10) **cebaba** a
   Imagen a dibujar texto (paradoja de la negación). Ahora 1 mención concisa + regla:
   el único texto en pantalla son etiquetas de producto/villano vía `textOverlays`.

### Videos de prueba generados (en `storage/runs/`)
- Frutinovela SuperCalm (denso + Kling pro potente) — validó densidad + animación.
- **Vitaly Gotas** (`final-vitaly.mp4`) — el pipeline generó escenas **densas solas**
  para un guion/marca NUEVOS con el preset bakeado → validó que la ruta se transfiere.

### Commits de la V2 (orden): `38280db` → `0dad365` → `ebba651` → `91e0884` → `1c1faf9` → `2a73a6d`

### ⚠️ Pendientes de la V2 (lo importante para seguir)
1. **Validar e2e el aprendizaje**: re-aprender un estilo DESDE 0 y confirmar que el
   preset sale con `referenceImages` poblado + densidad en el prompt, AUTOMÁTICO. (La
   lógica está; falta la corrida. Hoy el preset frutinovela fue medio-manual.)
2. **Cablear `motionIntensity`** al animador (`scene-animator/buildMotionPrompt`) —
   hoy es solo dato en el perfil de ruta; la animación potente se aplicó a mano.
3. **Negative prompt en los providers** (refuerzo anti-texto): hoy NO se usa negative
   prompt → suprimir texto/lettering ahí blindaría el fix del scene-planner.
4. **Validar el fix anti-texto** con una corrida nueva (confirmar que no sale caption).
5. **Voseo argentino** en prompts viejos (chip de tarea pendiente) — el código nuevo
   ya está en neutro; falta limpiar `claude-chat-discuss` baseStyle + validator-chat-ia.

---

## 0.AAAAA. SUBTÍTULOS — SRT + ZapCap + editor (30-may-2026)

> Feature nueva: ponerle subtítulos al video DESPUÉS de renderizado, estilo CapCut,
> con texto editable. El owner NO quiere subtítulos quemados por el pipeline (los
> sacó del flujo hace tiempo porque "no tomaba bien las letras").

### Lo que se construyó (todo en `apps/web/`)
- **Export `.srt` con texto exacto** — `GET /api/runs/[id]/subtitles` genera un SRT con
  el texto EXACTO del guion (scene-plan) + tiempos por frase. `?json=1` devuelve las
  líneas para el editor. Sin transcripción → sin errores de letras. Botón en el video terminado.
- **Editor de subtítulos en la página del run** — `runs/[id]/ZapCapSubtitles.tsx`: botón
  **"Agregar subtítulos"** → muestra el guion EDITABLE (cada línea con su tiempo), se
  corrige el texto, y se descarga el `.srt` con las ediciones (client-side).
- **Integración ZapCap** (subtítulos animados estilo CapCut por API):
  - `apps/web/lib/zapcap.ts` — cliente: upload (`POST /videos`) → task (`POST /videos/{id}/task`
    con templateId + `renderOptions.styleOptions.fontUppercase`) → poll (`GET .../task/{taskId}`)
    → descarga el MP4. Base `https://api.zapcap.ai`, auth header `x-api-key`.
  - `POST /api/runs/[id]/subtitles/zapcap` genera (style + MAYÚSCULAS) → guarda
    `final-subtitled.mp4`. `GET` lo sirve (inline para `<video>`; `?download=1` attachment;
    `?check=1` dice si existe). El video subtitulado se **reproduce embebido** en la página.
  - Templates reales (de `GET /templates`): Hormozi 3 (default), Ella, Luke, Celine, Maya.
  - **Probado end-to-end OK** (Hormozi 3 + uppercase → final-subtitled.mp4 7.4MB).

### ⚠️ Cosas a saber
- **Marca de agua ZapCap** = plan GRATUITO. Se quita con plan pago ($10/mes Starter+);
  misma API key, sin tocar código.
- **Keys en `.env`** (gitignored, NUNCA en el repo): `ZAPCAP_API_KEY`, `ZAPCAP_WEBHOOK_SECRET`.
  Placeholders en `.env.example`.

### Pendientes (no implementados)
1. **Inyectar el texto editado a ZapCap** — hoy ZapCap transcribe del audio (puede errar).
   Su API permite editar la transcripción antes de renderizar (`autoApprove:false` +
   `POST /videos/{id}/task/{taskId}/approve-transcript`) → con eso el video estilizado
   usaría las palabras EXACTAS del owner. Es el siguiente paso natural.
2. **Persistir las ediciones del editor** (hoy son client-side, se pierden al recargar).

### 🔒 Git (REGLA del owner, 30-may)
- **NO hacer `git push` a GitHub salvo que el owner lo pida explícitamente.** Commits
  locales SÍ (red de seguridad). Repo: github.com/fcastrocinf-creator/video-factory.
- Estado: el trabajo de subtítulos está commiteado LOCAL (no subido). `origin/main` quedó
  en el último push autorizado (la auditoría + integración ZapCap base).

---

## 0.AAAA. AUDITORÍA PREVENTIVA + 31 FIXES (29-may-2026, sesión tarde/noche)

> Tras generar el primer video completo end-to-end con el co-pilot, un proceso
> automático (el Editor IA post-render) **regeneró una escena que el owner ya había
> aprobado**. Eso disparó una **auditoría preventiva multi-agente** (66 agentes,
> verificación adversarial) que confirmó que NO era un caso aislado: **50 bugs reales**
> (1 crítico, 17 altos, 21 medios, 11 bajos), 9 falsos positivos descartados.

### Estado git de esta sesión
- **Rama `audit-fixes`** (8 commits de fixes). `main` quedó como **checkpoint** del
  estado funcional previo, tag **`checkpoint-pre-audit-fixes`**.
- **Rollback total:** `git checkout main` (o `git reset --hard checkpoint-pre-audit-fixes`).
- **Para adoptar los fixes:** revisar la rama y `git checkout main && git merge audit-fixes`.
- **Typecheck del monorepo entero: VERDE** tras los 31 fixes (`pnpm -r typecheck`).
- Antes de la auditoría se hizo el primer commit real desde 21-may (158 archivos;
  toda la capa validator-chat + colaborativo quedó versionada).

### Los 8 lotes aplicados (31 de 50 bugs cerrados)
1. **Consent (crítico):** el Editor IA y el loop holístico ya **no regeneran escenas
   pre-aprobadas del fork**; se resuelve por `scene.index` (no por posición). [cierra el
   incidente + #1,#3,#8,#13,#16,#17,#34,#36,#37]
2. **Status/UI + data-loss:** RunViewer muestra el video en `completed-with-warnings`
   (no "Pendiente"); "Reintentar" ya **no hace `rm -rf` de escenas aprobadas** (redirige
   a Forkear); el zombie-detector **no mata runs colaborativos pausados**. [#2,#12,#18,#19]
3. **Índice-vs-posición** en `image-gen-multi` (juez + sequence-validator). [#14,#30]
4. **Atomicidad + chat:** `markInterventionProcessed` usa **rename atómico** (no corrompe
   `interventions.jsonl`); el chat externo persiste el turno del owner **tras** la
   respuesta (no deja turnos huérfanos) y descarta `assistant` inicial. [#11,#21,#24,#33,#46]
5. **Visibilidad + consent + schema:** fallos del holistic/animator/editor-loop ahora
   marcan `completed-with-warnings` (no éxito silencioso); el **timeout ya no auto-acepta**
   una escena sin OK del owner (corta con mensaje → fork); schema del holistic robusto
   (trunca, no rompe). [#15,#20,#28,#29,#35]
6. **Cascada + intervene:** un **403 de Vertex** (billing/permiso) salta al próximo
   provider; `/intervene` rechaza runs terminados/auto (no más pendientes fantasma). [#22,#45]
7. **Consistencia:** al regenerar imagen sin re-animar se **limpia `videoPath`** → el
   compositor usa la imagen nueva, no el clip viejo (fix antes inefectivo). [#9,#10]
8. **Atomicidad/docs:** `scene-duration` escribe atómico; doc del `/resume` inexistente
   corregido a `/intervene`. [#39,#44]

### Backlog restante (~18 — bajo/medio valor, NO bloquean)
Quedaron sin tocar a propósito (riesgo/valor): se documentan para hacer por tandas.
- **Cost-tracking inexacto** (#5,#6,#7,#42,#43) — es un **estimador interno**; el número
  mostrado subcuenta los clips de video. Refactor mayor, no rompe nada funcional.
- **Mitigados ya por otros fixes:** #31 (el judge re-muestrea scene 0, pero el guard del
  Lote 1 impide que eso regenere lo aprobado) · #46 (cerrado por el rename atómico).
- **Menores/cosméticos:** #26 (status no refleja holistic `needs-major-rework`), #32
  (coerción de category neutraliza un guard de criticals), #38 (dedup del editor), #47
  (palette al holistic), #48 (fork eager usa comments cross-run), #49 (fork TOCTOU),
  #50 (logs por posición), #23 (cap de propagación silencioso), #41 (dead-wiring
  `skipMissingImages`), #40 (comentario `/resume` en `pipeline.ts:97`).
- **Detalle completo de los 50:** el resultado de la auditoría está en
  `C:\Users\cmktc\AppData\Local\Temp\claude\...\tasks\wpg4gy0q0.output` (efímero; si se
  quiere permanente, regenerar la auditoría o copiarlo a `investigacion/`).

### Pendiente de producto (feature, no bug)
- **Escena de CTA editable y flexible:** el owner pidió que el CTA sea una **escena de
  primera clase** al final del script, editable como cualquier otra (visual + copy), y
  **flexible** en contenido: solo llamada a la acción / mostrar producto / oferta /
  urgencia / etc. Hoy el CTA es un `narrativeBeat: 'cta'` (la última escena), editable
  en visual pero **no en copy**, y sin afordancia explícita. Implementar como feature.

### Regla reforzada
- **NUNCA un proceso automático debe regenerar/sobrescribir una escena que el owner
  aprobó** (o pre-aprobó vía fork) sin su consentimiento. Es la invariante #1 del sistema.

---

## 0.AAA. ÚLTIMA SESIÓN (29-may-2026) — VALIDATOR CHAT IA conversacional + modo "Hacer video en conjunto"

> Esta sesión fue larga (21→29 may). Construyó la prioridad #1 del owner: una **IA tipo
> chat (Claude) que conversa con la herramienta, mira cada escena y cada frame, dice
> "esto está mal, corrígelo y mándamelo de nuevo" y co-crea el video escena por escena
> con el owner**. Nada de esto estaba en los docs previos. TODO el código está en disco
> y typechequeado, pero **sin commitear** (ver §0.AAA.7).

### 0.AAA.1 — Qué se construyó (el gran avance)

**A) Ecosistema VALIDATOR CHAT IA** (4 módulos en `apps/web/lib/`):

| Módulo | Modelo | Cuándo corre | Qué hace |
|---|---|---|---|
| `validator-chat-ia.ts` (core, 123KB) | Sonnet 4-5, multi-turn + extended thinking | Post-animación, por escena | Extrae keyframes del clip MP4 (ffmpeg, 2 fps) + imagen estática → los manda a Claude → veredicto `right/wrong` + 7 scores + issues + `nextAction` + `correctedImagePrompt/MotionPrompt` + `systemicAntiPattern`. Loop auto-corrige hasta `maxAttempts` (el pipeline pasa 3). Persiste en `storage/validator-chat-ia/<runId>/`. |
| `validator-chat-ia-preflight.ts` | Haiku 4-5 | (PENDIENTE de cablear) | Revisión PRE-generación: lee solo el TEXTO del imagePrompt y caza anti-patrones antes de gastar una generación. **Aún NO está integrado en el pipeline.** |
| `validator-chat-ia-holistic.ts` | Sonnet 4-5 | Post-run, 1 vez | Mira el video entero como secuencia (contact-sheet con ffmpeg) → `globalVerdict` (ready/needs-work/needs-major-rework) + `recommendedRegenerateIndices`. Cableado en `pipeline.ts:1256`, con auto-regen de hasta 5 escenas. |
| `validator-chat-ia-external-chat.ts` | Sonnet 4-5, temp 0.3 | Bajo demanda | Chat owner ↔ VALIDATOR sobre un run ("¿por qué falló scene 7?", "ignora burned-text en scene 3"). Persiste overrides. Endpoint `/api/runs/[id]/validator-chat-ia/chat`. |

**B) Modo colaborativo "Hacer video en conjunto"** (co-creación escena por escena):
- DB (`db/schema.ts`): la tabla `runs` ganó `mode ('auto'|'collaborative')`, `pausedAtSceneIndex`, `awaitingApproval`, `originalRunId` (linaje de fork).
- **Flujo:** en modo `collaborative` el pipeline corre con **concurrencia 1** (secuencial). Tras animar cada escena, el animator llama `waitForApprovalIfCollaborative()` (`collaborative-mode.ts`) → marca `awaitingApproval=true` en la DB y **polea `interventions.jsonl` cada 5s** (timeout defensivo 60 min → acepta as-is). El owner aprueba/rechaza/comenta/skip vía `POST /intervene`, lo que libera la pausa.
- **Asistente de feedback en lenguaje natural (2 pasos):**
  1. `POST /suggest-feedback` — Claude expande una observación corta del owner a un comentario rico con contraste wrong/right (system prompt en **español neutro tú**).
  2. `POST /translate-feedback` — Claude traduce ese feedback natural a un `imagePrompt` técnico en inglés.
- `propagate-corrections.ts` — cuando corriges una escena, Claude (Sonnet) reescribe los `imagePrompt` de las escenas futuras NO animadas para mantener continuidad (personaje/estilo/objeto). Cap silencioso de 15 escenas.
- `owner-feedback.ts` — persiste las intervenciones (`interventions.jsonl` = inbox, `run-feedback.jsonl` = auditoría) + **memoria cross-run** en `storage/owner-feedback-memory/<brand>/<preset>.jsonl` que se **inyecta al VALIDATOR** para que recuerde tus correcciones entre runs.
- `/scene-duration` — recorte manual de una escena (`manualDurationSeconds` en scene-plan.json; no regenera, el compositor lo respeta).
- `/fork` — **el "repositorio"**: copia las escenas 0..N de un run a un run nuevo y reanuda desde la primera no aprobada. Sirve para continuar mañana, probar una alternativa desde la escena N, o **recuperar trabajo tras una caída del dev-server**.
- `/audit` — re-auditoría profunda (Sonnet) de todas las imágenes de un run (solo lectura).
- `auto-fix.ts` — self-healing de la **codebase** (no del video): captura errores del pipeline/endpoints, le pide a Sonnet un fix, lo aplica con backup + typecheck + revert si rompe. Infraestructura transversal.

**C) DOS UIs colaborativas (¡importante!):**
- **`/runs/[id]/build`** → `BuildCollaborative.tsx` (~1872 líneas) — **la UI real "Hacer video en conjunto"**: una escena a la vez (la pausada), polling 3s, imagen estática + clip lado a lado, scores/issues/rationale, sugerencias predefinidas según el verdict, caja de comentario libre, comparación **antes/después** al regenerar, recorte manual. Se entra desde el botón "🤝 Hacer video en conjunto" en `/create` (`CreateForm.tsx`).
- **`/runs/[id]/live`** → `LiveCoPilot.tsx` (~546 líneas) — dashboard secundario de **todas** las escenas (polling 5s, solo metadata textual, sin imagen/video). Se llega por un link desde `/build`.

### 0.AAA.2 — Dónde quedamos exactamente (al cerrar la sesión)

- Estabas co-creando en **`/runs/5fc3ac29-3379-4c7d-8027-b38d3dab4e49/build`** un **rip del anuncio SOOMI EsoRepair** (médico japonés, suplemento sublingual), estilo **B-roll animado acuarela sepia**.
- Avance: escenas 4 y 5 aprobadas, escena 6 rechazada con feedback en lenguaje natural:
  *"el gotero no puede entrar a un frasco cerrado; muestra el frasco destapado con la pipeta entrando y sacando el líquido para las gotas"*.
- El run quedó pausado esperando aprobación en la **escena 7**.

### 0.AAA.3 — ⚠️ EL ÚLTIMO ERROR (dos capas distintas)

**Capa 1 — el bug real de la herramienta (este es el que hay que arreglar):**
`storage` log del run `5fc3ac29`, escena 4, intento 2:
```
type: schema-error · "VALIDATOR response no matchea schema"
correctedMotionPrompt: "String must contain at most 2000 character(s)"
```
El VALIDATOR (Sonnet, con thinking) escribió un `correctedMotionPrompt` de **más de 2000 caracteres**. El schema Zod lo limita a `.max(2000)` ([validator-chat-ia.ts:303](apps/web/lib/validator-chat-ia.ts:303)) y, como NO tiene `.transform()` de truncado, el `safeParse` falla y **se descarta el veredicto entero** ([validator-chat-ia.ts:1312](apps/web/lib/validator-chat-ia.ts:1312)). El loop lo trata como error técnico (`verdict=null` → aborta `passed:false`) aunque Claude SÍ había emitido un juicio. Agravante: el system prompt **no le dice a Claude** que respete ese límite de longitud. **Esta es la causa raíz de la queja recurrente "el validator no es capaz de corregir": a veces no es que no vea el error, es que su propia respuesta se cae por longitud.** Mismo riesgo en `correctedImagePrompt` (.max 2000), `rationale` (.max 1500), `description` (.max 800), `systemicAntiPattern` (.max 500), y en `staticImageOk`/`rationale` que son requeridos sin coerción.
→ **Fix sugerido (rápido, bajo riesgo):** cambiar los `.max(N)` de los campos de texto largos por `.max(N).transform(s => s.slice(0, N))` (o `.catch`) para truncar en vez de rechazar, Y añadir al system prompt el límite explícito de caracteres.

**Capa 2 — lo que mató el chat anterior (NO es un bug de Video Factory):**
```
API Error: 400 messages.131.content.5: `thinking` or `redacted_thinking` blocks
in the latest assistant message cannot be modified.
```
Bug del harness de Claude Code: un bloque de "thinking" del historial quedó modificado (típicamente al encolar mensajes mientras el asistente respondía). A partir de ahí **toda** petición se rechazó con el mismo 400 ("q paso??" → mismo error, "?" → mismo error). El chat quedó irrecuperable desde adentro. **La salida correcta fue abrir un chat nuevo** (esta sesión).

### 0.AAA.4 — Estado actual del runtime (verificado 29-may)

- 🔴 **Dev server caído** (no responde en `:3000`).
- 🔴 **Run `5fc3ac29`** → `status=failed`, `current_step="aguardando aprobación · scene 7"`, `progress=80`. Lo auto-marcó failed el detector de runs zombie al caerse el server (no se perdió el trabajo de las escenas aprobadas; se puede **forkear** desde la última escena buena).

### 0.AAA.5 — Mapa de archivos nuevos/clave de esta sesión

**lib nuevos (`apps/web/lib/`):** `validator-chat-ia.ts`, `validator-chat-ia-preflight.ts`, `validator-chat-ia-holistic.ts`, `validator-chat-ia-external-chat.ts`, `collaborative-mode.ts`, `owner-feedback.ts`, `propagate-corrections.ts`, `auto-fix.ts`, `scene-patch-tracker.ts`, `unified-judge.ts`.
**lib muy modificados:** `pipeline.ts` (integra collaborative + validator + holistic), `scene-animator.ts` (cascada Kling/Veo/Higgsfield + `reanimateWithOverride` + Ken Burns + consistency-guard), `runs-repository.ts`.
**endpoints nuevos (`apps/web/app/api/runs/[id]/`):** `collaborative-state`, `intervene`, `translate-feedback`, `suggest-feedback`, `scene-duration`, `validator-history`, `validator-chat-ia/`, `fork`, `audit` (+ `scene-plan`, `product`, `thumbnail`, `video`).
**UI nueva (`apps/web/app/(app)/runs/[id]/`):** `build/BuildCollaborative.tsx`, `live/LiveCoPilot.tsx`.

### 0.AAA.6 — scene-animator: cómo anima ahora (3 cosas que pediste)

1. **Cascada image-to-video:** Higgsfield primary si `preferHiggsfield` (UGC/realista), si no **Kling primary** (B-roll animado) → **Veo fallback**. Retry cíclico Kling→Veo→Higgsfield (no reintenta con el mismo provider porque daría el mismo clip).
2. **Ken Burns vs animación real (#142/#143):** para estilos **ilustrados** (acuarela/sepia/comic/pixar/ghibli) el pipeline pasa `skipVideoGen=true` → NO usa IA de video (que deforma/re-encuadra), y el **compositor aplica Ken Burns fiel a la estática**. Para UGC/fotorealista SÍ usa IA de video. El forzado global de Ken Burns fue **revertido** porque querías animación real (`KEN_BURNS_ONLY=1` lo fuerza si hace falta). `buildMotionPrompt` ya NO inyecta el imagePrompt (evita que Kling re-imagine) y tiene **FRAMING LOCK** anti-reencuadre; solo mueve la boca si `scene.speaking`.
3. **Consistency guard (#133):** si tras regenerar la imagen el `.png` quedó más nuevo que el `.mp4` (la re-animación falló), fuerza UNA re-animación antes de pausar → resuelve el problema que reportaste de "la imagen estática no tiene nada que ver con el clip animado".

### 0.AAA.7 — 🐞 Bugs y fragilidades CONOCIDAS (en orden de impacto)

1. **[CRÍTICO] VALIDATOR pierde el veredicto por longitud** — el schema-error de §0.AAA.3. Es el que rompe la experiencia "el validator no corrige". Arreglar primero.
2. **`markInterventionProcessed` no es atómico en Windows** ([owner-feedback.ts:261](apps/web/lib/owner-feedback.ts:261)) — escribe a `.tmp` y luego sobre el archivo directamente (sin rename). Un crash a mitad corrompe `interventions.jsonl`. El comentario dice "atomic" pero no lo es.
3. **Endpoint `/resume` fantasma** — `collaborative-mode.ts` y `pipeline.ts` documentan reanudar vía `POST /api/runs/[id]/resume`, que **no existe**. La reanudación real es: `/intervene` persiste → el polling loop libera la DB. (No crear ese endpoint pensando que falta.)
4. **`preflight` no está cableado** en el pipeline — el módulo existe pero el hook `onBeforeGenerate` no se llama. Integrarlo ahorraría generaciones.
5. **`RunViewer.tsx` no tiene botón al co-pilot** — a `/build` y `/live` solo se llega desde `/create`. Un run ya creado no ofrece entrar al modo colaborativo desde su vista normal.
6. **`propagateCorrections` cap silencioso de 15 escenas** — en videos largos (hasta ~50 escenas) las correcciones no llegan a las escenas lejanas; solo queda un `warn` en log.
7. **Race del inbox de intervenciones** — `interventions.jsonl` lo leen dos puntos (scene-animator pre-VALIDATOR y collaborative-mode durante la pausa); una intervención puede consumirse en el lugar equivocado y dejar la pausa colgada hasta el timeout.
8. **Timeout = aceptación**, pero los comentarios de cabecera dicen "failed" (docs desincronizadas del código).
9. **`LiveCoPilot` no muestra imagen ni video** (solo metadata) aunque la página lo promete; **`BuildCollaborative` deja el polling corriendo** indefinidamente al terminar (no-op confeso).
10. **Cost tracking por provider inexacto** — clips Veo/Kling se contabilizan como 'higgsfield'/'openai' (placeholders).
11. **OOM histórico** — 5 escenas animando + 5 VALIDATOR con thinking + frames base64 reventaban el heap; mitigado bajando concurrencia a 2 en modo auto (no es fix de raíz).

### 0.AAA.8 — Git: TODO sin commitear

- Último commit: `177c1ca` (21-may, "orquestador de composición en 4 fases").
- **158 archivos modificados sin commitear** — TODA esta sesión (validator-chat-ia, modo colaborativo, co-pilot, cascada del animator, etc.). Si el disco se pierde, se pierde todo. **Considerar un commit pronto** (el owner decide cuándo; no commitear sin que lo pida).

### 0.AAA.9 — Próximos pasos sugeridos

1. **Arreglar el schema-error del VALIDATOR** (§0.AAA.3 / bug #1) — truncar los campos largos con `.transform` + instruir el límite en el system prompt. Es lo que más te molesta.
2. **Levantar el dev server** (§7) y **forkear el run `5fc3ac29`** desde la última escena buena para retomar el rip de SOOMI sin perder lo aprobado.
3. Revisar el resto de bugs de §0.AAA.7 según prioridad (el #2 de corrupción del inbox es importante para no perder intervenciones).
4. (Opcional) Cablear el `preflight`, agregar el botón al co-pilot en `RunViewer`, y commitear.

---

## 0.AA. ÚLTIMA SESIÓN (27-may-2026) — Cerebro evolutivo + auto-learn loop al 95%

Implementación de las 3 piezas críticas del "cerebro autoevolutivo" + auto-learn
end-to-end. Toda la sesión auditada en 13 pasadas, 14 bugs/hardenings corregidos.

### Capa nueva M7 #1/#3/#5

- **#1 Burned-in text detector** (`packages/blocks/post-render-judge/src/burned-text-detector.ts`)
  Detecta texto glitchy/gibberish/wrong-language en visuales con Claude Vision.
  Integrado en M5 visual sample → si severity≥medium, M6 emite `regenerate-scene`
  automático con prompt reforzado.

- **#3 Feedback loop de aprobación humana** (`packages/core/src/preset-judgment-memory.ts`)
  `recordPresetJudgment()` registra `approved`/`rejected`/`edited`/`run-success`/
  `run-failed`/`used-for-rip` en `storage/preset-memory/judgments.jsonl`.
  `getPresetConfidenceScores()` calcula ranking. Wired en: approve endpoint,
  pipeline run-completed, pipeline run-failed. Inyectado en `buildSystemContext`
  → cada llamada Claude ve la confidence histórica.

- **#5 Auto-mejora de prompts (cerebro evolutivo real)** (`apps/web/lib/prompt-evolution.ts`)
  `detectSystemicPatterns()` escanea logs + post-render-reports buscando errores
  que se repiten en N+ runs distintos. `proposePromptPatch()` le pide a Claude
  Sonnet un patch al SYSTEM_PROMPT del bloque afectado. `applyPatch(id)` lo
  escribe al source (DENTRO del template literal, no fuera) si owner aprueba.
  UI en `/admin` sección "🧬 Cerebro evolutivo". Endpoints:
  `POST /api/admin/prompt-patches` (detect) + `POST /api/admin/prompt-patches/[id]/decide`.

### Auto-learn loop al 95% (M7-B v3) — 3 puntos de entrada

- **Hook automático al finalizar rip** (`pipeline.ts`): si `referenceVideoPath`,
  dispara `runPresetLearningLoop({targetScore: 95, maxIterations: 4})` en background
- **Hook automático al subir video** (`/api/training/upload/route.ts`): mismo loop
- **Botones manuales en UI**: `/rip/[id]` y `/aprendizaje/[id]` con sliders config

El loop: video-understand → genera imagen test → compara con keyframe vía
Gemini Vision → refina prompt con Claude → repite hasta 95% o agotar iters.
Preset final + reporte `.iterations.json` quedan en `packages/presets/pending/`.

### Auto-recovery de runs zombies (27-may-2026)

`GET /api/runs/[id]` detecta runs `status=running` con `startedAt > 45 min` y
los auto-marca `failed`. **Nunca más correr `scripts/mark-run-failed.ts`
manualmente** cuando el dev server caiga. La UI muestra el botón retry de inmediato.

### Mejoras también aplicadas en esta sesión

- **ad-analyzer mejorado** (`apps/web/lib/ad-analyzer.ts`):
  - Prompt v2: detección exhaustiva (1 escena cada 2-6s vs heurística vieja "8-25 ads")
  - Hard constraint de duración real con ffprobe (evita alucinación de timestamps)
  - `maxOutputTokens: 65536` (suficiente para 50+ escenas)
  - `temperature: 0` (determinístico)
  - Sanity checks post-parse + auto-truncate de timestamps fuera de rango
  - **Validado:** 15 → 49 escenas en VIDEO 2.mp4 (167s), densidad 3.4s/escena
- **video-understander mejorado**: prompt v2 + migrado a `judgeWithClaude` unificado
- **M7 Pieza C v2 — unified-judge**: primitivos centralizados en
  `packages/core/src/claude-judge.ts`. Migrados: preview-judge, subtitle-judge,
  editor-loop, editor-verdict, video-understander. -141 líneas de plumbing duplicado

### Bugs corregidos (13 pasadas de auditoría exhaustiva, 14 bugs+hardenings)

1. `applyPatch` rompía archivos TypeScript al appendear fuera del template literal
2. 3 mappings incorrectos en `BLOCK_TO_SOURCE`
3. Regex no soportaba `export const`
4. `loadPatches()` durante render → loop infinito React → fixed con `useEffect`
5. Loop iterativo perdía progreso si una iter fallaba → try/catch per-iter
6. `getPresetConfidenceScores` NaN cascade si weight inválido
7. Race condition lost-write en `updatePatchStatus` → mutex promise chain
8. `patchType: 'removal'` broken por contradicción schema
9-10. `maxDuration: 300` en endpoints largos (Vercel)
11-13. Input bounds en 3 endpoints (prevenir abuse)
14. `readRecentEvents` sin try/catch en readFile + invalid date filter

### Scripts útiles dejados en `scripts/`

- `mark-run-failed.ts` — marca run zombie como failed (workaround manual,
  ya no necesario con auto-detection pero queda como debug tool)
- `test-prompt-extraction.cjs` — valida que los 5 mappings de BLOCK_TO_SOURCE
  funcionan al 100% (regex extract + apply round-trip)
- `test-ad-analyzer.ts` — corre el analyzer mejorado contra un MP4 y reporta
  conteo + densidad de escenas (usar `pnpm exec tsx`)
- `test-editor-flow.cjs` — valida endpoint composition GET→PUT + loop aprendizaje
- `validate-scene-count.cjs` — independent check con Claude Sonnet vs Gemini

### Bug conocido NO resuelto: hex codes leak en imágenes

El image generator (gpt-image-1/Imagen) está incrustando los hex codes del
`dominantPalette` del promptTemplate **como texto burned-in en la imagen**
(ej. `#5DC3D2E #3D2B1F` aparece como label sobre la escena). El detector
de burned-in text del M5 lo flagea, M6 pide regenerar, pero el origen
sistémico es el `styleBoilerplate` del preset auto-learned que incluye
"Dominant palette: #...". El cerebro evolutivo va a detectar el patrón
después de varios runs y proponer un patch al auto-learn-preset para que
NO incluya los hex codes literales en el promptTemplate, solo nombres de
colores ("warm sepia, amber, dark brown").

---

## 0.A. FIX (25-may-2026) — Higgsfield endpoint corregido

`packages/blocks/video-gen-veo/src/higgsfield-video-client.ts` ahora apunta al
endpoint REAL `/v1/image2video/dop` (model DoP — Director of Photography), NO al
inexistente `image-to-video/soul/standard` (Soul es text-to-image).

Cambios:
- `HiggsfieldVideoModel` = `'dop-lite' | 'dop-turbo' | 'dop-standard'`
- Default: `dop-turbo` (2x speed + priority queue, recomendado UGC)
- Flujo: upload de imagen vía `/files/generate-upload-url` → submit a
  `/v1/image2video/dop` con body `{params: {model, prompt, input_images, duration}}` →
  poll `/requests/{id}/status`
- Detección "Not enough credits" funcionando (403 + match en body)

**Validado contra API real (25-may-2026 14:00 UTC):** endpoint responde 403
"Not enough credits" — confirma URL/auth/body OK. Para activar el routing
UGC→Higgsfield en runtime hace falta recargar saldo en
https://platform.higgsfield.ai → Billing. Mientras tanto el sistema cae
gracefully a Kling (ya implementado en `apps/web/lib/scene-animator.ts`).

Test: `node scripts/test-higgsfield-video.cjs` (standalone, sin tocar pipeline).

---

## 0. RESUMEN EJECUTIVO — dónde estamos

Se completó el **orquestador de composición** en 4 fases (todas con typecheck verde, código en disco):

1. **Fase 1** — Motor de composición libre (geometría arbitraria, no solo grids)
2. **Fase 2** — Detector de geometría exacta del video original
3. **Fase 3** — Editor manual de composición (canvas drag/resize/rotar + re-render)
4. **Fase 4** — Loop de aprendizaje (la IA aprende de las correcciones manuales)

**TODO el código está escrito, guardado y typechequeado.** El billing de Google
Cloud ya quedó habilitado en sesiones posteriores (proyecto `gen-lang-client-0913919937`).
El pipeline de generación ya corrió múltiples runs end-to-end (ver `storage/runs/`).
La sección "BUG PENDIENTE — BILLING DE GOOGLE CLOUD" más abajo es histórica.

El flujo del editor de composición (Fase 3) → loop de aprendizaje (Fase 4) ya
está VALIDADO end-to-end vía `scripts/test-editor-flow.cjs` (25-may-2026):
- GET → PUT del endpoint `/api/runs/[id]/composition` responde correctamente
- `recordCompositionCorrection` se dispara con `learnedCorrections: N` en la
  respuesta del PUT, donde N es el número de elementos editados
- El JSONL se persiste con la entrada completa (AI rect vs Human rect, rotation,
  opacity, zIndex, narration del scene)

**⚠ Path real del JSONL:** `apps/web/storage/composition-memory/corrections.jsonl`
(NO `storage/composition-memory/` raíz). Esto se debe a que `process.cwd()` del
Next dev server es `apps/web/`. Tanto `recordCompositionCorrection` (write) como
`queryRelevantCompositionCorrections` (read en `composite-layout-detector.ts`)
usan el mismo `defaultCompositionMemoryPath()` → son consistentes. Si en algún
momento se ejecuta el detector desde un script standalone con cwd=raíz, va a
mirar otra ruta y NO leerá las lecciones. Solución futura: usar una variable
de entorno tipo `VIDEO_FACTORY_STORAGE_ROOT` para anchor absoluto.

**Lo que sigue sin validar:** que el detector real CONSUMA las lecciones
inyectadas vía few-shot en su prompt. Eso requiere disparar un rip nuevo y
mirar el bloque "LEARNED FROM PAST MANUAL CORRECTIONS" en los logs del
`composite-layout-detector.ts`.

### Próximo paso inmediato
1. Disparar un rip nuevo en `/rip` con cualquier video original
2. Mirar los logs del dev server — debe aparecer el bloque
   "LEARNED FROM PAST MANUAL CORRECTIONS" si hay correcciones relevantes en el
   JSONL (matchea por brand/preset/narration similar)

---

## 1. EL PROYECTO

**Video Factory** — herramienta interna para generar videos verticales 9:16 (ads
TikTok/Reels) para marcas D2C (Vitaly, Nelo).

- **Ruta:** `C:\Users\cmktc\proyectos\video-factory`
- **Stack:** monorepo TypeScript · Next.js 14 · Remotion 4.x · Drizzle ORM + libsql · pnpm
- **Funcionalidad "Ripear":** toma el video de un anuncio existente y genera uno
  nuevo, adaptado al producto propio, replicando estructura y estilo.

**Flujo del pipeline (rip alta fidelidad):**
`script-processor → narrator-analyzer → tts-elevenlabs → subtitles-google →
scene-planner → rip-fidelity-aligner → compositor-remotion → final.mp4`

---

## 2. ESTADO ACTUAL — LAS 4 FASES DEL ORQUESTADOR

### Fase 1 — Motor de composición libre ✅
Antes solo existían layouts rígidos (grid-2x2, etc.). Ahora hay posicionamiento
arbitrario:
- **`CompositeElement`** (en `packages/contracts/src/scene.schema.ts`): cada pieza
  tiene `rect {xPct,yPct,widthPct,heightPct}`, `rotationDeg`, `opacity`, `zIndex`,
  `fit`, `cornerRadiusPct`, `startSeconds/endSeconds`, `textOverlay`, `manuallyAdjusted`.
- **`Scene.composition: CompositeElement[]`** — cuando está poblada, tiene prioridad.
- **`FreeformComposite` + `FreeformElement`** (en `PlanoEscenas.tsx`): componentes
  Remotion que renderizan geometría arbitraria (collage irregular, PiP, overlays).

### Fase 2 — Detector de geometría exacta ✅
- El detector (`composite-layout-detector.ts`) ahora devuelve `rect {x,y,w,h}` en %
  por cada panel — la geometría REAL del original, no una plantilla genérica.
- `generateCompositeScene` (en `rip-fidelity-aligner.ts`) construye un
  `CompositeElement[]` con esas coordenadas y lo propaga a `scene.composition`.

### Fase 3 — Editor manual ✅
- **Página:** `/runs/[id]/editor` — canvas 9:16 con drag (mover), handles de
  esquina (redimensionar), inputs de rotación/opacidad/capa/borde, lista de capas,
  duplicar/eliminar piezas, "crear composición" desde cero.
- **Endpoints:**
  - `GET/PUT /api/runs/[id]/composition` — lee/guarda la composición (scene-plan.json)
  - `GET /api/runs/[id]/scene-asset?file=...` — sirve imágenes del workDir al canvas
  - `POST /api/runs/[id]/rerender` — re-renderiza el video con la composición editada
- **Re-render:** regenera el `final.mp4` SIN regenerar imágenes (solo Remotion, rápido y barato).
- **Persistencia:** el pipeline ahora guarda `scene-plan.json` y `render-job.json`
  en el workDir del run (antes NO se persistía el sceneTrack).
- Botón "Editor de composición" agregado en la página del run (`RunViewer.tsx`).

### Fase 4 — Loop de aprendizaje ✅
- **`packages/core/src/composition-memory.ts`**: registra cada corrección manual
  como par (geometría que propuso la IA ↔ geometría final del humano).
  Storage append-only en `storage/composition-memory/corrections.jsonl`.
- El `PUT /composition` compara lo guardado contra la propuesta original de la IA
  (`render-job.json`) y registra la corrección (`diffComposition`).
- El detector de geometría carga las correcciones relevantes
  (`queryRelevantCompositionCorrections`) y las inyecta como ejemplos few-shot en
  su prompt → con cada edición manual, el modo automático mejora.

---

## 3. HISTORIAL DE ESTA SESIÓN — bugs encontrados y arreglados

Antes de las 4 fases hubo una larga sesión de debugging corriendo 4 rips. Bugs:

### Bug 1 — Validación muerta y silenciosa
El detector de composites y el reviewer usaban `gemini-2.5-pro`, cuyo quota diario
(1000 req) se agotó. Cuando fallaban, caían **silenciosamente** a "todo OK" — por
eso pasaban grids con texto gibberish sin que nadie se enterara.
**Fix:** detector + reviewer migrados a `gemini-2.5-flash` (10K req/día), con
logging visible de fallbacks, retry con backoff exponencial, y `maxOutputTokens`.

### Bug 2 — Next.js cacheaba módulos viejos
Tras editar los `lib/*.ts`, el dev server seguía ejecutando el código antiguo.
**Fix:** reiniciar el `pnpm dev`. (Gotcha recurrente — ver sección 8.)

### Bug 3 — ROOT CAUSE: el preset le pedía texto a la IA
El preset `learned-vitaly-media-23faa1f14cc9-bfd664eb` tenía en su `promptTemplate`:
> "Text overlays are bright green, high-contrast TikTok style, driving the key messages."

Le pedía **activamente** al generador que incrustara texto verde tipo TikTok.
**Fix:** se reescribió el `promptTemplate` y el `negativePrompt` del preset
(`packages/presets/pending/learned-vitaly-media-23faa1f14cc9-bfd664eb.preset.json`)
— quitando esa línea, el `#39FF14`, y agregando `text, caption, split-screen,
grid, collage` al negative prompt.

### Otros fixes
- **Anti-composite/anti-text prefix:** cuando el reviewer rechaza una imagen por
  composite/texto alucinado, se inyectan directivas explícitas al INICIO del
  prompt de regeneración (los image generators respetan más las primeras palabras).
- **Auto-escalado a composite:** si el generador alucina grids de forma
  persistente (todos los attempts rechazados por composite), el aligner deja de
  pelear y escala la escena a generación composite real (panel por panel) —
  `hallucinatedCompositePersistently` en `rip-fidelity-aligner.ts`.
- **`expectedSingleShot`:** flag que el reviewer usa para rechazar composites
  cuando se esperaba un plano único.
- **`grid-3x2`:** layout de 6 paneles agregado al schema/detector/renderer.

### Último run exitoso
`f4c6fe8f-cf73-435a-a6f9-f45bfbd0fca8` — 50 imágenes, video 128s, SIN texto
gibberish (gran mejora vs. runs anteriores). Aún tenía algunas escenas composite
no deseadas — eso lo resuelve el auto-escalado + las 4 fases nuevas.

---

## 4. ARCHIVOS CLAVE DE ESTA SESIÓN

### Creados
| Archivo | Qué hace |
|---|---|
| `apps/web/app/api/runs/[id]/composition/route.ts` | GET/PUT de la composición + registro de aprendizaje |
| `apps/web/app/api/runs/[id]/scene-asset/route.ts` | Sirve imágenes del workDir al canvas del editor |
| `apps/web/app/api/runs/[id]/rerender/route.ts` | Dispara el re-render |
| `apps/web/lib/rerender-composition.ts` | Función de re-render (solo compositor) |
| `apps/web/app/(app)/runs/[id]/editor/page.tsx` | Página del editor |
| `apps/web/app/(app)/runs/[id]/editor/CompositionEditor.tsx` | UI del editor canvas |
| `packages/core/src/composition-memory.ts` | Loop de aprendizaje (registro + query + diff) |

### Modificados
| Archivo | Cambio |
|---|---|
| `packages/contracts/src/scene.schema.ts` | `CompositeElement`, `Scene.composition`, `grid-3x2` |
| `apps/web/lib/composite-layout-detector.ts` | flash, `rect`, retry, logging, `DetectContext`, lessons |
| `apps/web/lib/scene-reviewer.ts` | flash, `expectedSingleShot`, retry, maxOutputTokens, logging |
| `apps/web/lib/rip-fidelity-aligner.ts` | detección composite, auto-escalado, `composition` |
| `packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx` | `CompositeFrame`, `FreeformComposite` |
| `packages/blocks/compositor-remotion/src/block.ts` | proyecta `composition` a `CompositeElementVisual` |
| `packages/blocks/compositor-remotion/src/index.ts` | exports nuevos |
| `apps/web/lib/pipeline.ts` | persiste `scene-plan.json` + `render-job.json` |
| `apps/web/app/(app)/runs/[id]/RunViewer.tsx` | botón "Editor de composición" |
| `packages/core/src/index.ts` | export `composition-memory` |
| `packages/presets/pending/learned-vitaly-...preset.json` | `promptTemplate` corregido |

> Estado git: hay cambios sin commitear. NO se ha hecho commit todavía — decidir
> si commitear antes o después de la prueba en runtime.

---

## 5. BILLING — RESUELTO (histórico)

> **Estado 25-may-2026:** El billing GCP ya quedó habilitado y el pipeline corre
> end-to-end. Esta sección queda como referencia histórica para troubleshooting
> si en algún momento el quota vuelve a ser el cuello de botella.

- **Proyecto GCP:** `gen-lang-client-0913919937`
- **Vincular billing:** `https://console.cloud.google.com/billing/linkedaccount?project=gen-lang-client-0913919937`
- **Habilitar Vertex AI:** `https://console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=gen-lang-client-0913919937`

**Cuellos de saldo actuales (otras platforms):**
- **Higgsfield video (DoP image-to-video):** sin créditos → endpoint validado
  contra API real pero submits caen con 403 "Not enough credits". Recargar en
  https://platform.higgsfield.ai → Billing. Sistema cae graceful a Kling.
- **Anthropic API:** key activa y validada. Modelo default `claude-haiku-4-5`
  (barato). System-context inyectado en cada call vía M9.

---

## 6. PRÓXIMOS PASOS CONCRETOS

1. **Habilitar billing GCP** (sección 5).
2. **Reiniciar el localhost** si no está arriba (sección 7).
3. **Disparar un rip de prueba** (sección 7) — esto genera un run con
   `scene-plan.json` y `render-job.json`.
4. **Verificar en los logs del dev server:**
   - `rip-aligner:composite_detected` con geometría
   - `rip-aligner:freeform_composition_built` (Fase 2)
   - `rip-aligner:escalating_to_composite` (auto-escalado, si aplica)
   - que NO aparezcan `FALLBACK` del detector/reviewer (señal de quota OK)
5. **Abrir el editor:** `/runs/{nuevoRunId}/editor` — probar mover/redimensionar
   piezas, "Guardar", "Re-renderizar".
6. **Verificar el loop de aprendizaje:** tras guardar una edición, debe aparecer
   `storage/composition-memory/corrections.jsonl` con la corrección registrada.
7. **Opcional:** commitear todo el trabajo de la sesión.

---

## 7. DETALLES OPERATIVOS

### Levantar el localhost
```
cd C:\Users\cmktc\proyectos\video-factory
pnpm --filter '@video-factory/web' dev
```
Corre en `http://localhost:3000`. **Gotcha:** al cambiar archivos `lib/*.ts` a
veces hay que reiniciarlo para que tome los cambios (Next.js cachea módulos server).

### Autenticación
- `POST /api/auth` con body `{"password": "<APP_PASSWORD del archivo .env>"}`
- Devuelve cookie `app_auth`. El password está en `.env` (raíz del repo).

### Disparar un rip de prueba
```
POST /api/rip/27ad591c-ad6c-4975-ba92-59f25e06dfda/rip
Body: {
  "brandId": "vitaly",
  "presetId": "learned-vitaly-media-23faa1f14cc9-bfd664eb",
  "productId": "vitaly_gotas",
  "fidelityMode": "high"
}
```
- **Rip ID de prueba:** `27ad591c-ad6c-4975-ba92-59f25e06dfda` (video `media-23faa1f14cc9.mp4`)
- El rip corre en background (~25-35 min). Devuelve un `runId`.

### Consultar estado de un run (DB)
```
cd apps/web && node -e "const {createClient}=require('@libsql/client');const c=createClient({url:'file:../../db/local.db'});(async()=>{const r=await c.execute({sql:\"SELECT id,status,current_step,progress,image_count FROM runs ORDER BY started_at DESC LIMIT 5\",args:[]});console.log(JSON.stringify(r.rows,null,2));})();"
```

### Datos clave
- **DB:** `db/local.db` (libsql), `DATABASE_URL=file:./db/local.db`
- **Último run exitoso:** `f4c6fe8f-cf73-435a-a6f9-f45bfbd0fca8`
- **Brand de prueba:** `vitaly` (`packages/brands/vitaly.brand.json`)
- **Preset de prueba:** `learned-vitaly-media-23faa1f14cc9-bfd664eb`
- **GCP credenciales:** `GOOGLE_APPLICATION_CREDENTIALS=C:\Users\cmktc\.gcp\video-factory-sa.json`
- **Modelos de visión:** detector + reviewer usan `gemini-2.5-flash`

### Typecheck
```
pnpm -r typecheck        # los 16 paquetes — actualmente TODO verde
```

---

## 8. GOTCHAS / COSAS QUE SABER

- **Next.js cachea módulos server:** tras editar `lib/*.ts`, reiniciar `pnpm dev`
  si el cambio no se refleja. (Causó el "Bug 2" de esta sesión.)
- **El editor solo funciona con runs NUEVOS:** los runs viejos no tienen
  `scene-plan.json` (la persistencia se agregó en esta sesión). Un run viejo en el
  editor muestra "404 — sin scene-plan.json", que es lo esperado.
- **Imágenes en el chat:** cuando el contexto de la conversación se satura, las
  capturas adjuntas fallan con error 400 "Could not process image". Workaround:
  guardar la captura en `C:\Users\cmktc\Desktop\claude-img\` y decir "mira" — el
  asistente lee el archivo más reciente con su lector de archivos local.
- **Preferencia de idioma:** español neutro (formas con "tú", sin argentinismos).
- **Billing GCP habilitado:** detector/reviewer ya no caen con 429. Si vuelven
  a aparecer 429s sostenidos es un cuello de cuota nuevo — chequear sección 5.
- **El `learned-vitaly` preset** está en `packages/presets/pending/` — los presets
  aprendidos quedan en `pending/` hasta aprobarse en `/admin`.

---

## 9. PENDIENTES FUTUROS (no bloqueantes)

- Cargar **assets reales de marca** (fotos del producto, logo) para Vitaly: el
  schema soporta `product.referenceImagePath` pero el brand `vitaly.brand.json`
  está vacío de imágenes, y el generador hoy solo usa descripciones de texto — por
  eso los productos salen con etiquetas inventadas. Conectar las fotos reales como
  reference images al generador resolvería esto de raíz.
- Aprobar el preset `learned-vitaly` en `/admin` si se quiere usar en `/create`.
- Considerar commitear el trabajo de la sesión a git.
