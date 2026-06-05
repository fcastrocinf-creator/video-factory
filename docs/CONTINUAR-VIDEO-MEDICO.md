# 🎬 CONTINUAR AQUÍ — Guía maestra para el próximo chat (Video Factory · ad del médico SuperCalm)

> 🔎 **Estado REAL del CÓDIGO (verificado el 5-jun-2026 con 2 rondas de comprensión total): `docs/ESTADO-VERIFICADO-2026-06-05.md`.** Léelo para el mapa del sistema (qué funciona de verdad, huecos reales, qué docs están stale). Nota: el owner **pausó** el estilo de ads "antes/después con persona" (médico) — este doc sigue como referencia del formato, no como tarea activa salvo que el owner lo retome.

> **Para el próximo Claude Code:** lee ESTE documento entero ANTES de tocar nada. Es el
> traspaso completo: el norte, el estado real del video, TODAS las herramientas, cómo se
> hizo, los errores que NO debes repetir, y cómo avanzar con lo que falta. Después lee
> `CLAUDE.md` (invariantes, se auto-carga) y `HANDOFF.md` (V10/V11). Último commit local:
> `bb8c75d` en `main` (NO hay push; nunca pushees sin orden explícita del owner).

---

## 0) Reglas DURAS del owner (rómpelas y la sesión se va al traste)

- **Español neutro SIEMPRE** (formas con "tú"). PROHIBIDO voseo (sos/tenés/querés/mirá/dale) y "acá" (usa "aquí"). Aplica a chat, código, prompts, UI, commits — TODO.
- **NUNCA `git push`** sin que el owner lo pida explícitamente. Commits locales OK cuando los pide.
- **NO subtítulos** salvo que el owner los pida (la compuerta los reclama; es un FALSO POSITIVO, ignóralo).
- **Nada se auto-aplica:** el sistema PROPONE, el owner aprueba. Antes de gastar créditos, **confirma** (y hazlo sobre EL video activo del owner, no un run cualquiera — error real cometido).
- **Verifica VIENDO y OYENDO**, no solo leyendo logs ni mirando frames sueltos. El owner detecta lo que tú no si no miras a fondo.
- **No parches a mano; cierra el círculo:** el valor es que la HERRAMIENTA detecte y corrija sola (con OK del owner). Cada parche manual es señal de algo que el pipeline debería hacer.
- **Respuestas cortas "para doomies"**, pero ejecuta de forma autónoma y verifica a fondo.

---

## 1) EL NORTE (qué estamos construyendo)

Video Factory tiene un **círculo de 8 pasos** para perfeccionar ads. El objetivo: que la
herramienta **detecte y corrija sola** los defectos de un video (con OK del owner), en vez
de que el owner los arregle a mano. Plan por fases: `docs/PLAN-CIERRE-CIRCULO.md`.
- ✅ **Fase 0** (impregnar invariantes), **Fase 1** (mostrar hallazgos en el run), **Fase 2** (el "brazo": auto-reparar la escena que falla).
- ⏳ **Fase 3** (que el PIPELINE EMITA formatos complejos solo: PiP, multi-voz, anotaciones por word-sync — hoy se arman semi-a-mano) y **Fase 4** (regenerar+aprender).

**Trampa que debes tener siempre presente** (invariante `motor-soporta-vs-pipeline-emite`):
el **motor** (Remotion/`PlanoEscenas.tsx`) SOPORTA PiP/chroma/anotaciones/multi-voz, pero el
**pipeline automático** (`pipeline.ts`) NO los EMITE solo. El ad del médico hoy se arma con
scripts semi-manuales (`prep-key.ts` + `proto-key.ts`), NO por el pipeline. Automatizar eso
es Fase 3.

---

## 2) ESTADO REAL DEL VIDEO (el ad del médico SuperCalm)

**Qué es:** ad UGC vertical 9:16, ~17s. Un MÉDICO (autoridad) presenta el caso de ROSA
(antes/después con el producto SuperCalm). Es un RIPEO (se adapta un ad de referencia al
producto del owner). La marca en el ad se nombra **"SuperCalm"** a secas.

**Render bueno actual:** `storage/proto-composite/supercalm-key15.mp4` (aprobado por el owner: "se ve mucho mejor"). Para abrirlo: `Start-Process` (Windows) sobre esa ruta.

**Estructura del montaje** (`packages/blocks/compositor-remotion/src/proto-key.ts`):
1. **Hook (0-8s):** clip del médico hablando a cámara (voz nativa Veo) + teaser del producto en esquina.
2. **Rosa antes→intermedio→después (8-16s):** fotos `estado1_hinchada` → `estado2_media` → `estado3_renovada` (MISMA mujer, editada) + médico en **PiP** (clip recortado, con movimiento) + **círculos rojos** sincronizados a "ojeras"/"papada" + packshot en esquina.
3. **Producto (16-17s):** packshot real `packshot.jpg`.
- Audio = `combined-key.mp3` = voz NATIVA concatenada de 2 clips Veo (hook + off). El compositor MUTEA los videos; el audio sale de `combined-key.mp3` → el lipsync calza por construcción.

**✅ Resuelto (no lo rompas):**
- Voz del médico = **NATIVA de Veo 3.1** (no ElevenLabs). Lipsync calza.
- Médico en **PiP con movimiento** (clip recortado = "corte y posición").
- 3 estados de Rosa = misma mujer; círculos sincronizados; producto presente.

**❌ MICRO-ERRORES PENDIENTES** (los detecté con revisión a fondo — el owner quiere que se arreglen; aún NO se hizo):

| # | Error | Cuándo | Tipo |
|---|-------|--------|------|
| 1 | Corte hook→Rosa duro; el médico **parpadea** justo al cortar; PiP/packshot aparecen de golpe | ~8s | transición |
| 2 | La cara de Rosa **BRINCA** (jump cut: estado1→estado2 mal alineados); círculos **desaparecen de golpe** | ~11.7s | transición |
| 3 | Micro-brinco estado2→estado3; la "mejora" es **imperceptible** | ~13.2s | transición + contenido |
| 4 | **Destello fantasma**: Rosa se transparenta sobre el producto (crossfade sucio) | ~16s | transición |
| 5 | **Manos del médico deformes** (dedos fusionados/pinza) | ~1s, ~4s | artefacto Veo |
| 6 | El **PiP del médico salta de escala/pose** (el clip es selfie con mucho movimiento) | 8-16s | overlay |
| 7 | **Packshot con claims laterales cortados** (recuadro chico, fit cover) | hook + 8-16s | legibilidad |
| 8 | **Oclusiones**: PiP (arriba-der) y packshot (abajo-der) tapan parte de la cara de Rosa | 8-16s | composición |
| 9 | **Audio del empalme** (~8s): cambio de ambiente/reverberación al pegar 2 clips; respiraciones, sibilancia (~12s), pop final (~16s) | varios | audio |
| 10 | **Fade-in oscuro** breve al inicio; **~1s de silencio** al final | 0s / 16-17s | extremos |

> El owner valida AMBOS canales: ver (frames) Y oír (transcripción). No declares "listo" sin pasar por la compuerta y sin mirar/oír.

---

## 3) TODAS LAS HERRAMIENTAS (inventario completo)

### 3.1 Validación / percepción (lo que VE y OYE)
| Herramienta | Qué hace | Cómo se usa |
|---|---|---|
| **Compuerta de calidad** `apps/web/lib/kb/quality-gate.ts` (`runQualityGate`) | Orquesta el panel + el juez Gemini → veredicto `pass/revisar/fail`. **AHORA corre OBLIGATORIA en cada render** (ver §5). | CLI: `pnpm tsx scripts/run-quality-gate.ts --render <mp4> --gemini` (exit 0/1/2). |
| **Juez Gemini ve+oye** `apps/web/lib/render-quality-judge.ts` | Sube el VIDEO completo a Gemini (imagen+audio+tiempo). 8 dimensiones + **AUDITORÍA FORENSE** de micro-errores (transiciones/audio/manos/oclusiones, con timestamp). | Lo invoca la compuerta. Devuelve hallazgos con `startSec`. |
| **Panel multi-agente** `apps/web/lib/kb/format-audit.ts` | 6 especialistas con visión sobre keyframes: composicion-recorte, animacion-movimiento, voces-diarizacion, producto-legibilidad, captions-anotacion, fidelidad. Extensible (`extraSpecialists`). | Lo invoca la compuerta. |
| **motion-map** `apps/web/lib/motion-map.ts` | Detecta CORTES (cambios de plano) + tramos animado/estático por frame-diff. | Úsalo para saber DÓNDE muestrear frames (los cortes). |
| **Skill `video-intelligence`** | Comprensión PROFUNDA de un ad (Gemini nativo + motion-map): guión, escenas, voces, PiP, estructura. | `pnpm tsx scripts/video-intelligence.ts "<mp4>"`. Persiste en `storage/kb/formatos/`. |

### 3.2 El "brazo" (auto-reparar la escena que falla — Fase 2)
| Pieza | Qué hace |
|---|---|
| `apps/web/lib/repair-plan.ts` (puro) | Traduce un `RepairTarget` del gate → `CorrectionParse` (qué escena regenerar y con qué dirección). Testeable sin DB/IA. |
| `apps/web/lib/repair-executor.ts` (efectos) | Forkea el run y regenera SOLO la escena del hallazgo, **reusando `applyCorrection`** (vía `parseOverride`). |
| `POST /api/runs/[id]/gate/repair` + botón "🦾 Auto-reparar" en `GateFindings.tsx` | El owner aprueba → se dispara la reparación dirigida. Re-deriva del reporte persistido (no confía en el cliente). |
| `inspect-repairs.ts` | `pnpm tsx scripts/inspect-repairs.ts <runId>` → ve qué reparaciones propone el gate, sin gasto. |

### 3.3 Generación (modelos) — CUÁL usar para qué
| Necesidad | Modelo | Cómo |
|---|---|---|
| **Cara que HABLA con voz nativa + lipsync** (médico) | **Veo 3.1** (talking-head con diálogo) | MCP de generación `generate_video` model `veo3_1`: foto (`start_image`) + la LÍNEA hablada EN EL PROMPT. ⚠️ máx 8s. ⛔ NUNCA TTS de ElevenLabs encima (patina); ⛔ Seedance NO da lipsync; ⛔ Higgsfield DoP NO genera voz. |
| Persona/cara realista (foto) | **Higgsfield SOUL `soul_2`** | da piel real, no "alien". Pasar foto base como referencia para identidad (antes/después). |
| Movimiento UGC sin voz | **Higgsfield DoP** (`higgsfield-video-client.ts`, `dop-turbo`) | image-to-video; NO genera voz. |
| Imágenes del pipeline | `image-gen-multi` (con validator de anatomía/gibberish) | parte del pipeline automático. |

### 3.4 El MCP de generación (Higgsfield) — id `aae7bd69-7a4d-4f1c-9dd4-a94c03336f11`
Tools (cárgalas con ToolSearch `select:mcp__aae7bd69...__<tool>`):
- `balance` (créditos), `models_explore` (catálogo/constraints — acción `recommend`/`get`/`list`),
- `media_upload` + `media_confirm` (subir foto/audio local → media_id; PUT los bytes a la upload_url con `curl.exe`),
- `generate_video` (model + prompt + medias + `get_cost:true` para preflight),
- `job_display` (estado de un job por id; el video tarda ~5-15 min en cola), `show_generations`.
- Flujo: subir media → `generate_video` (preflight con `get_cost`) → poll `job_display` hasta `completed` → descargar `results.rawUrl` con `curl.exe`.
- Balance al cierre de esta sesión: ~4.7k créditos (Veo 3.1 fast 8s ≈ 22 créditos).

### 3.5 Scripts (todos en `scripts/`, correr con `pnpm tsx scripts/<x>.ts`)
| Script | Para qué |
|---|---|
| `prep-key.ts` | Arma el audio del tramo (`combined-key.mp3` = concat de los clips Veo) + copia assets + `manifest-key.json`. |
| `packages/blocks/compositor-remotion/src/proto-key.ts` | RENDERIZA el tramo: `pnpm tsx <ese archivo> <workDir=storage/proto-key> <out.mp4>`. Aquí está el timeline (hook, Rosa, PiP, círculos, producto). |
| `transcribe-gemini.ts <audio.mp3>` | Transcribe audio con timestamps (verificar OYENDO + timing de palabras como "ojeras"). |
| `analyze-audio.ts <audio.mp3>` | Auditoría forense de AUDIO (clicks, empalmes, volumen, timbre, respiraciones). |
| `extract-frames-at.ts <mp4> <prefijo> <t1,t2,...>` | Extrae frames en tiempos dados (para mirar). |
| `extract-mosaic.ts <mp4> <out.png>` | Mosaico de frames. ⚠️ el `tile` puede fallar con el ffmpeg recortado de Remotion; usa `extract-frames-at` si falla. |
| `run-quality-gate.ts --render <mp4> --gemini` | Corre la compuerta a demanda sobre un mp4. |
| `pick-run-for-repair.ts` / `check-run.ts <runId>` | Listar runs reusables / ver estado+advisory de un run. |
| `tts-medico-hook.ts` | ⛔ DESCARTADO (era el intento ElevenLabs). NO usar — la voz va por Veo. |

### 3.6 Assets del médico (gitignored, en disco)
- `storage/proto-key/`: `medico-hook-veo.mp4` (clip hook, voz nativa), `medico-off-veo.mp4` (clip off, voz nativa), `medico-ugc.png` (foto base del médico, soul_2), `estado1_hinchada/estado2_media/estado3_renovada.png` (Rosa), `packshot.jpg` (producto real), `combined-key.mp3`, `manifest-key.json`.
- `storage/proto-composite/`: los renders `supercalm-key*.mp4` (key15 = el bueno) + frames de inspección.

---

## 4) CÓMO VERIFICAR A FONDO (el método que pide el owner)

1. **Correr la compuerta** (Gemini ve+oye): `run-quality-gate.ts --render <mp4> --gemini` → veredicto + hallazgos con `startSec`.
2. **Mirar frames densos Y en los CORTES** (no solo uno suelto): `extract-frames-at.ts` con tiempos alrededor de cada empalme (antes/después). Los cortes están en el motion-map.
3. **Oír el audio**: `transcribe-gemini.ts` (palabras correctas) + `analyze-audio.ts` (glitches/empalmes).
4. **Mirar los EXTREMOS** (inicio/fin) — ahí se esconden fades y silencios.
5. Solo entonces decir si está bien. El owner empuja a profundizar: revisa transiciones, manos, oclusiones, audio del empalme.

---

## 5) EL CANDADO: la validación ahora corre SIEMPRE (no la rompas)

Invariante `validacion-siempre-obligatoria`. La grieta histórica: la compuerta era OPT-IN
(flag) + silenciosa → un video se declaraba "listo" sin validar. Ya NO:
- En `pipeline.ts` la compuerta corre **OBLIGATORIA, con `await`, `useGemini:true`** al terminar cada render (se eliminó `VF_GATE_ON_RENDER`).
- El **estado final depende del veredicto**: `completed` SOLO si `pass`; si fail/revisar o no pudo validar (sin Gemini) → `completed-with-warnings` marcado "NO VERIFICADO" (fail-loud + fail-closed). NUNCA "listo" a ciegas.
- **Test guardián** `apps/web/lib/quality-gate-wiring.test.ts`: ROMPE si alguien la vuelve opt-in/fire-and-forget o desacopla el estado. Córrelo: `pnpm exec tsx --test apps/web/lib/quality-gate-wiring.test.ts`. **Si lo rompes, NO lo "arregles" desconectando la validación — arregla el wiring.**
- **Costo real:** cada render ahora tarda ~2-3 min más y gasta el gate (Gemini) en CADA video. Es a propósito.

---

## 6) CÓMO AVANZAR con lo que falta (playbook para los micro-errores de §2)

> Empieza confirmando con el owner sobre qué video trabajas y qué arreglar primero. NO regeneres a lo loco. Varios son ajustes de `proto-key.ts` SIN gastar.

**Sin regenerar (editar `proto-key.ts` + re-render local, barato):**
- **#7 packshot cortado:** el packshot es ancho; con `fit:'cover'` en un rect chico corta los claims. Usa `fit:'contain'` o un rect con el aspecto del packshot, o un packshot recortado al recuadro.
- **#8 oclusiones:** mueve el PiP/packshot para no tapar la cara de Rosa (el PiP arriba-der come la sien; el packshot abajo-der come la mejilla). Reduce tamaño o reubica.
- **#2 círculos de golpe / #4 cierre fantasma:** los cortes son SECOS. Añade fundidos cortos (opacity ramp) en entradas/salidas de círculos y en la transición a producto. El crossfade del cierre se ve "sucio" porque el producto entra sobre el bg de Rosa — corta más limpio o cubre con un fondo sólido.
- **#10 silencio final / fade inicio:** recorta el plano de producto a lo que dura el audio; revisa el fade-in del compositor.
- **#1 médico parpadea al corte:** ajusta `HOOK_END` para no cortar en un parpadeo (o usa otro frame de salida).

**Requieren regenerar (gasta — confirma con el owner):**
- **#5 manos deformes / #6 PiP que salta:** regenera el clip del médico con un prompt que pida manos quietas / encuadre estable (menos movimiento de cámara selfie). Veo 3.1, verificar oyendo.
- **#3 progresión de Rosa imperceptible:** regenera/edita los 3 estados para que la mejora se NOTE (estado1 más hinchada, estado3 claramente más definida). Editar UNA foto base para variar (no generar cada estado por separado) — invariante `usuaria-antes-hinchada-progresion`.
- **#9 audio del empalme:** si molesta, regenera el médico como UN solo clip (no 2) o iguala el ambiente; o acepta el corte.

**El "brazo" (auto-reparar)** ya existe para regenerar una escena de un RUN del pipeline. Pero el ad del médico es un PROTO manual (no un run), así que el brazo no aplica directo aún — eso se resuelve cuando el pipeline EMITA el formato (Fase 3).

---

## 7) Errores REALES de esta sesión (NO los repitas)

1. **Gasté créditos en el VIDEO EQUIVOCADO** (un run cualquiera) probando el brazo, en vez del video del médico → el owner se enojó. Antes de gastar, confirma que es EL video activo; si algo no encaja técnicamente, dilo y pregunta. (Memoria: `confirmar_video_activo.md`.)
2. **Puse al médico como FOTO fija** → estático/muerto. Las personas en hook/PiP van como **CLIP con movimiento** (corte y posición). (`pip-persona-corte-posicion`.)
3. **Monté TTS de ElevenLabs sobre el clip** → "lipsync inexistente". La voz va NATIVA del mismo modelo (Veo). (`lipsync-voz-nativa`.)
4. **Verifiqué con frames sueltos** y dije "listo" → el owner vio errores que yo no. Verifica VIENDO (denso + cortes) Y OYENDO.
5. **Un guardián laxo** (regex que matcheaba un comentario) pasó cuando no debía → al escribir tests de wiring, asegúrate de que realmente cazan la regresión (pruébalos fallando a propósito).

---

## 8) Punteros (orden de lectura para el próximo chat)
1. **Este documento** (`docs/CONTINUAR-VIDEO-MEDICO.md`).
2. `CLAUDE.md` → sección **Invariantes** (23, se auto-carga). Especialmente: `validacion-siempre-obligatoria`, `lipsync-voz-nativa`, `pip-persona-corte-posicion`, `motor-soporta-vs-pipeline-emite`, `verificar-viendo-y-oyendo`.
3. `HANDOFF.md` → V10/V11 (resumen de sesiones).
4. `docs/supercalm-doctor-receta-ejecucion.md` → playbook reproducible del formato (sección "✅ MÉTODO PROBADO").
5. `docs/PLAN-CIERRE-CIRCULO.md` → el plan por fases.
6. `ARQUITECTURA.md` → visión completa del sistema (3 modos: Crear/Ripear/Aprender).

## 9) Comandos rápidos
- Typecheck: `pnpm -r typecheck` (monorepo) o `pnpm --filter @video-factory/web typecheck`.
- Tests del brazo + guardián: `pnpm exec tsx --test apps/web/lib/quality-gate-wiring.test.ts apps/web/lib/repair-plan.test.ts apps/web/lib/kb/repair-loop.test.ts`.
- App: `pnpm --filter @video-factory/web dev` → `http://localhost:3000`. Auth por cookie `app_auth=valid` (para `curl.exe`). Admin: clave en `ADMIN_PASSWORD` del `.env`.
- Re-render del tramo del médico: `pnpm tsx scripts/prep-key.ts` luego `pnpm tsx packages/blocks/compositor-remotion/src/proto-key.ts "<...>/storage/proto-key" "<...>/storage/proto-composite/supercalm-keyNN.mp4"`.
</content>
