# HANDOFF — Video Factory · Orquestador de composición

> Documento de traspaso entre conversaciones de Claude Code.
> Para continuar: abre un chat nuevo en este proyecto y di **"lee HANDOFF.md y seguimos"**.
> 💡 Backlog de ideas futuras (para barrer e implementar): **`IDEAS.md`**.
> Última actualización: 2026-06-04 (Versión 10).

---

## 🚀 VERSIÓN 10 — 04-06-2026 (Ad del médico RESUELTO: voz NATIVA Veo + PiP con movimiento + método impregnado en la herramienta)

> **🚦 ARRANQUE.** Render bueno (aprobado por el owner "se ve mucho mejor"): `storage/proto-composite/supercalm-key15.mp4`. El método quedó GUARDADO en los **invariantes** (IA in-app) + la **receta** para que la herramienta lo aplique sola en videos de este tipo. El owner: *"que la herramienta pueda entenderlo cuando se necesiten videos de este tipo"*.

### 1. ✅ Lo resuelto (render `supercalm-key15.mp4`)
- **Voz del médico = NATIVA de Veo 3.1** (⛔ no ElevenLabs, ⛔ no HeyGen, ⛔ no Seedance). 2 clips Veo (hook + off, ≤8s c/u); su audio se concatena en `combined-key.mp3`; el compositor MUTEA los `<video>` → el **lipsync calza por construcción**. La compuerta dejó de marcar el lipsync.
- **Médico en PiP con MOVIMIENTO** = el clip off recortado y posicionado ("corte y posición"), no foto fija.
- Producto presente en el antes/después + cierre corto + círculos re-sincronizados a la voz nativa ("ojeras"@~1.8s, "papada"@~2.6s del off).
- Verificado **VIENDO** (frames) **y OYENDO** (transcripción): el médico dice bien sus líneas.

### 2. 🧠 Errores que se cazaron y corrigieron (en orden)
- Médico como **FOTO fija** (hook 10s + PiP) → ESTÁTICO/muerto. El owner: *"sigue teniendo errores, no puedes verlos?"* → clip con movimiento.
- **TTS de ElevenLabs** sobre clip Seedance → "lipsync inexistente" (la compuerta lo cazó). El owner: *"usas el narrador de Eleven, hazlo con el mismo higgsfield"* → Veo voz nativa.
- (Sesión: al principio gasté en un VIDEO EQUIVOCADO probando infra — ver memoria `confirmar_video_activo.md`.)

### 3. 🔒 Dónde quedó GUARDADO (para que la herramienta lo aplique solo)
- **Invariantes** (`apps/web/lib/kb/invariants.ts` `CORE_INVARIANTS` → inyectados a la IA in-app + sync a `CLAUDE.md`, **22 invariantes**): actualizado **`lipsync-voz-nativa`** (Veo, nunca ElevenLabs/HeyGen/Seedance) + NUEVO **`pip-persona-corte-posicion`** (PiP = clip con movimiento).
- **Receta del formato** (`docs/supercalm-doctor-receta-ejecucion.md`): sección **"✅ MÉTODO PROBADO (key15)"** como playbook; lo viejo (HeyGen/ElevenLabs) marcado SUPERADO.
- **Memoria del Claude:** `voz_nativa_y_pip_movimiento.md`, `confirmar_video_activo.md`.

### 4. 🛠️ Playbook (cómo se reproduce este formato)
2 clips Veo del médico (foto soul_2 `medico-ugc.png` como `start_image` + la línea EN EL PROMPT, ≤8s, **verificar oyendo** con `transcribe-gemini.ts`) → `scripts/prep-key.ts` (concat del audio nativo → `combined-key.mp3` + `manifest-key.json`) → `pnpm tsx packages/blocks/compositor-remotion/src/proto-key.ts <workDir> <out>` (hook + Rosa antes/después + PiP médico clip + círculos + producto) → `scripts/run-quality-gate.ts --render <mp4> --gemini` (ve+oye). Assets en `storage/proto-key/` + `storage/proto-composite/` (gitignored). Scripts nuevos esta sesión: `extract-audio.ts`, `extract-frames-at.ts`, `tts-medico-hook.ts` (este último ya NO se usa — fue el intento ElevenLabs).

### 5. ▶️ Siguiente
- **NORTE pendiente:** que el PIPELINE EMITA este formato SOLO (Veo por hablante + PiP corte-y-posición + círculos por word-sync) en vez de armarlo con `prep-key.ts`/`proto-key.ts` a mano → invariante `motor-soporta-vs-pipeline-emite` + `docs/PLAN-CIERRE-CIRCULO.md` (Fase 3). El "brazo" de auto-reparación (V9) sigue disponible.
- **Sin commit aún** (pedir al owner). Esta sesión también construyó el "brazo" Fase 2 (ver V9 abajo) — hay bastante sin commitear.

---

## 🚀 VERSIÓN 9 — 04-06-2026 (Fase 2 parte 2: EL "BRAZO" construido — auto-reparar la escena que falla, con tu OK)

> **🚦 ARRANQUE.** El NORTE sigue: cerrar el círculo (que la herramienta CORRIJA sola, con OK del owner). Esta sesión construyó el **BRAZO** de la Fase 2 (pasos 6-7 del círculo): el sistema ya puede **localizar el defecto en una escena** y **regenerar SOLO esa escena con tu OK** (botón "🦾 Auto-reparar"). **Construido + verificado a nivel código (typecheck 19/19 + 15 tests); FALTA la 1ª prueba REAL (gasta créditos) → la disparas tú.** Lee la V8 (debajo) para el diagnóstico del círculo y el estado del tramo SuperCalm.

### 1. 🦾 Lo que se construyó (3 sub-fases, todas verificadas SIN gastar créditos)
- **2.2a — sceneIndex en los hallazgos (el pre-requisito que pediste):** antes el `GateBlocker` era solo texto+dimensión → `planRepairs` no podía targetear (`sceneIndex=null` siempre). Ahora:
  - `HallazgoDraft` (schema compartido, `deep-audit.ts`) + `Hallazgo`/`GateBlocker` (`findings.ts`) ganan `startSec`/`sceneIndex`/`endSec` (opcionales, aditivos — NO rompen deepAudit).
  - El **panel** (`format-audit.ts`) y el **juez Gemini** (`render-quality-judge.ts`) ahora reportan el SEGUNDO del defecto (`startSec`) — ya veían los frames rotulados `t=Xs`.
  - **`runQualityGate`** (que conoce el runId) carga el `scene-plan.json` del run y **mapea segundo→escena** (`sceneAtSec`, conservador: si cae fuera de rango → SIN escena, no apunta a una equivocada). `toBlocker` copia el sceneIndex al bloqueante.
  - **`planRepairs`/`routeByDimension`** (`repair-loop.ts`): con escena → `regenerate-image`/`reanimate` DIRIGIDO; sin escena (o edición/sistémico/audio-lipsync) → camino seguro `surface-to-editor`/`escalate`.
- **2.2b — el executor (la "mano"):** `repair-plan.ts` (PURO: `RepairTarget`→`CorrectionParse`, testeable sin DB/IA) + `repair-executor.ts` (EFECTOS: forkea el run, dispara). **REUSA `applyCorrection`** (no se construyó motor nuevo, invariante de no duplicar) vía un **`parseOverride`** nuevo en `correction-pipeline.ts` que SALTA el parseo NL de Gemini → targeting determinista. El fork **preserva el original**.
- **2.2c — el gatillo con tu OK:** `POST /api/runs/[id]/gate/repair` (re-deriva la reparación del reporte persistido; no confía en el cliente) + botón **"🦾 Auto-reparar"** en `GateFindings.tsx` (solo en acciones ejecutables; muestra "escena N" y enlaza al fork). **Nada se auto-aplica.**

### 2. ✅ Verificación (sin gastar créditos)
- `pnpm -r typecheck` → **19/19 paquetes verde** (incluido apps/web).
- **15 tests** pasan (`repair-loop.test.ts` 9 + `repair-plan.test.ts` 6): routing dirigido vs seguro, lipsync→escalate, edición→editor, plan determinista, truncado a 150, no-ejecutables→null.
- **NO se gastaron créditos** en el código (typecheck + tests con datos sintéticos).

### 2b. ✅✅ PRUEBA REAL end-to-end — PASÓ (04-06-2026, el círculo cerró de verdad)
Sobre el run real `568b8c8a` (vitaly, comic-sepia, 7 escenas):
- Compuerta con Gemini → **FALLA, 8 bloqueantes**, y **mapeó cada uno a su ESCENA** (`sceneIndex` 0/4/6 reales en el reporte persistido — el corazón de 2.2a, validado con IA real, no solo en test).
- `planRepairs` marcó 2 bloqueantes auto-reparables (render-av, escena 6); el resto a editor/escalar — correcto.
- Disparé el endpoint REAL `POST /api/runs/568b8c8a/gate/repair {blockerIndex:3}` ("Personaje inconsistente en el CTA") con cookie `app_auth=valid` → fork `165f59b6`.
- El log del server confirma: `correction:parsed fromOverride:true` (NO re-parseó con Gemini, usó el plan determinista), `affectedIndices:[6]`, regeneró imagen (Higgsfield, estilo sepia preservado), re-animó (Kling), re-renderizó, `correction:completed`.
- **Verificado VIENDO y OYENDO:** escenas 0-5 con **hash MD5 idéntico** (preservadas) + `audio.mp3` **bit-idéntico** (transcripción coherente: drenaje linfático / gotas Vitaly); **solo la escena 6 cambió** (regenerada coherente: producto + flecha de CTA, sin "alien"). El original quedó **intacto** (fork).
- Scripts de apoyo nuevos: `scripts/pick-run-for-repair.ts` (elige run reusable) + `scripts/inspect-repairs.ts` (ve qué propone planRepairs, sin gasto).

### 3. ▶️ SIGUIENTE PASO
- **El brazo está PROBADO end-to-end.** En la UI: run con `VF_GATE_ON_RENDER=1`+`VF_GATE_USE_GEMINI=1` → `/runs/[id]` muestra bloqueantes con "escena N" → botón "🦾 Auto-reparar" → fork. (En `.env` hoy `VF_GATE_ON_RENDER` falta y `VF_GATE_USE_GEMINI` está vacío → para auto-correr el gate al render, activarlos.)
- **Límites honestos:** (a) la **re-animación automática** solo corre para formatos `b-roll-animated`/`voiceover-animated` (este run lo era → re-animó con Kling ✅); para clips UGC (Higgsfield) falta rutear la re-animación a Higgsfield (no Kling) — refinamiento. (b) El **"audio del médico sin sentido"** (TTS global) sigue siendo **Fase 3** (multi-voz/audio por escena). (c) El `sceneIndex` se calcula en el gate pero aún NO se persiste en el hallazgo (`findings.jsonl`) → Fase 4 (aprender).
- Luego: **Fase 3** (auto-emit de composición: anotaciones por word-sync, PiP, multi-voz) y **Fase 4** (regenerar+aprender).

### 4. 🗂️ Archivos tocados (sin commit aún — pedir al owner)
- **Nuevos:** `apps/web/lib/repair-plan.ts`, `apps/web/lib/repair-executor.ts`, `apps/web/lib/repair-plan.test.ts`, `apps/web/app/api/runs/[id]/gate/repair/route.ts`.
- **Editados:** `apps/web/lib/kb/{deep-audit,findings,format-audit,quality-gate,repair-loop,repair-loop.test}.ts`, `apps/web/lib/render-quality-judge.ts`, `apps/web/lib/correction-pipeline.ts`, `apps/web/app/(app)/runs/[id]/GateFindings.tsx`, `docs/PLAN-CIERRE-CIRCULO.md`.

---

## 🚀 VERSIÓN 8 — 04-06-2026 (EL NORTE: cerrar el círculo "detectar → corregir SOLO" · diagnóstico del back-end · tramo SuperCalm key10)

> **Cambio de foco (pedido por el owner):** dejar de PARCHAR a mano el proto del tramo y
> trabajar en que la HERRAMIENTA detecte y CORRIJA sola. El owner: "es muy importante que
> entiendas a profundidad la situación... esto debe quedar absolutamente impregnado en el sistema".

> **🚦 ARRANQUE — LÉELO ANTES DE TOCAR NADA.** El NORTE es **cerrar el círculo del sistema**
> (que la herramienta corrija sola, con OK del owner), **NO** pulir el video del médico a mano.
> El error de la sesión pasada fue **parchar el proto pieza por pieza sin ver el sistema** — NO lo
> repitas. Orden de lectura: (1) `CLAUDE.md` (invariantes, se auto-carga), (2) esta Versión 8
> entera, (3) `docs/PLAN-CIERRE-CIRCULO.md`. **Entiende la TOTALIDAD y confirma el plan con el
> owner ANTES de ejecutar.** Usa las herramientas IA del sistema (gate, panel `format-audit`,
> `video-understander`), no scripts a mano. Verifica VIENDO **y OYENDO** (transcribe el audio).

### 1. 🎯 DIAGNÓSTICO (verificado leyendo ~30 archivos del back-end con 3 agentes)
Video Factory tiene un **círculo de 8 pasos** para perfeccionar videos, **partido por la mitad**:
- ✅ **1-4 funcionan:** LEER (Gemini ve+oye), ENTENDER (panel 6 especialistas `kb/format-audit.ts`), DETECTAR (`kb/quality-gate.ts`), PROPONER el fix en la KB (`kb/findings.ts`).
- ❌ **5-8 NO:** MOSTRAR el hallazgo en el editor · APLICAR la corrección · REGENERAR dirigido · APRENDER. El **`RepairLoop`** (`kb/quality-gate.ts`) está **solo tipado, sin implementar**.
- **Trampa clave:** el **motor** (Remotion/`PlanoEscenas.tsx`) SOPORTA PiP/chroma/anotaciones/multi-voz, pero el **pipeline** (`pipeline.ts`) **NO los EMITE** → capacidad ≠ autonomía. Cada parche manual del proto es una pieza que el pipeline debería emitir solo.
- Ceiling de automatización hoy: ~70% formatos simples, **~40% el ad del médico** (2 voces + PiP + antes/después + anotaciones).

### 2. 🗺️ LA RUTA — `docs/PLAN-CIERRE-CIRCULO.md` (plan perfecto, por fases)
Fase 0 **Impregnar** → 1 **Mostrar** (hallazgos al editor) → 2 **RepairLoop** (corregir con OK) → 3 **Auto-emit de composición** (anotaciones vía word-sync, PiP, multi-voz — automatizar lo que se hace a mano) → 4 **Regenerar + Aprender**. Se ejecuta **por fases verificadas** (typecheck + `/run` + gate); nada se auto-aplica.

### 3. 🧠 PROGRESO: Fases 0, 1 y 2-parte1 HECHAS (el círculo ya gira hasta "decidir el arreglo")
- **Fase 0 (Impregnar) ✅:** 3 invariantes (`circulo-leer-actuar`, `motor-soporta-vs-pipeline-emite`, `verificar-viendo-y-oyendo`) + sync a CLAUDE.md (21) + memoria del Claude + este HANDOFF + `docs/PLAN-CIERRE-CIRCULO.md`.
- **Fase 1 (Mostrar) ✅ verificada:** los hallazgos del gate ya se VEN en la página del run. Nuevos: endpoint `apps/web/app/api/runs/[id]/gate/route.ts` (lee `readQualityGateReport('gate:<runId>')`), componente `apps/web/app/(app)/runs/[id]/GateFindings.tsx`, montado en `RunViewer.tsx`. Typecheck verde + endpoint probado con curl.
- **Fase 2 (Aplicar) — parte 1 ✅ verificada:** `apps/web/lib/kb/repair-loop.ts` implementa `planRepairs` (+ `repair-loop.test.ts`, 4 tests pasan): traduce cada bloqueante → acción determinista por dimensión (`surface-to-editor` para edición / `escalate` para sistémico; `sceneIndex=null` por ahora). El endpoint /gate expone `repairs[]`; `GateFindings` muestra la "acción sugerida — con tu OK".
- **➡️ SIGUIENTE (Fase 2 parte 2 — el "BRAZO"):** el EXECUTOR que APLICA la reparación (regenerar SOLO la escena/audio que falla, con OK del owner). Necesita: (a) enriquecer el `GateBlocker` con `sceneIndex`/timing en `kb/format-audit.ts` (hoy es solo texto+dimensión, por eso `planRepairs` aún no targetea escenas); (b) el executor que regenera dirigido (los tipos `RepairAction`/`RepairTarget` ya existen en `kb/quality-gate.ts`). Luego Fase 3 (auto-emit de composición: anotaciones vía word-sync, PiP, multi-voz) y Fase 4 (regenerar+aprender).

### 4. ▶️ Estado del tramo SuperCalm (key10) — útil, pero con 2 errores REALES que cazó el owner
- **Logrado y verificado:** 3 estados de la MISMA mujer (resolvió el crítico de persona inconsistente), **producto = packshot REAL** (`OneDrive/.../SuperCalm/Neuron_SuperCalm_Logo1.jpg.jpeg`, copiado a `storage/proto-composite/packshot.jpg`; reemplaza la imagen generada con texto basura), **círculos sincronizados a la palabra** (transcripción: "ojeras"@~12.4s, "papada"@~13.4s), **progresión acentuada** (`estado1b_var1`/`estado3b_var1` editados con `nano_banana_2`, más contraste, misma mujer). Gate: **5→4→3→2 bloqueantes**; los que cayeron eran los reales.
- **2 errores que el Claude NO detectó y el owner SÍ (¡verificar OYENDO!):**
  1. **Audio del médico sin sentido:** el clip dice "la cara EN CHAQUETA" (→ hinchada), "mucha TENSIÓN" (→ retención), "un EJERCICIO" (→ este caso). Confirmado por `scripts/transcribe-gemini.ts`. Hay que rehacer el audio del médico.
  2. **Médico ausente en PiP** durante los planos de Rosa (el original lo tiene reaccionando en recuadro).
- **Bloqueantes que PERSISTEN (estructurales, NO del tramo):** fidelidad de formato (necesita el ad completo) + "la marca debería ser Nello" (falso positivo: el owner adapta a su producto, no copia la marca ajena del ad de referencia).
- **Marca elegida por el owner:** en el ad el producto se nombra **"SuperCalm"** a secas (no "Nello" ni "neuron").
- Render más reciente: `storage/proto-composite/supercalm-key10.mp4`. Backups de las fotos base: `estado1_orig.png` / `estado3_orig.png`. Script nuevo: `scripts/transcribe-gemini.ts` (transcribe audio con timestamps vía Gemini; OpenAI Whisper quedó sin cuota).

### 5. Reglas reforzadas (esta sesión, ya como invariantes)
- **Verificar VIENDO y OYENDO** (transcribir el audio), no solo frames.
- **No parchar protos a mano**: el valor es cerrar el círculo del sistema, usando sus herramientas IA.
- Marca del producto en el ad = **"SuperCalm"** a secas.

---

## 🚀 VERSIÓN 7 — 03-06-2026 (Tramo clave SuperCalm: lipsync por audio nativo · persona realista soul_2 · progresión antes/después · fix storage)

> **Foco:** seguir el TRAMO CLAVE (~23s) del ad del médico SuperCalm. El owner pidió arreglar el **lipsync**; al iterar surgieron 2 cosas más: la **persona se veía "alien"** y el **"antes" y "después" no eran la misma mujer** (crítico del gate). Resueltos los 3.

### 1. 🗣️ Lipsync — RESUELTO/MITIGADO (lo que pidió el owner)
- **Causa raíz:** se montaba un **TTS aparte ENCIMA** del clip muteado → patinaba. **Fix:** usar el **audio NATIVO del clip** (el modelo genera voz+labios juntos). El médico (hook) habla en cámara con su voz nativa → el gate bajó su lipsync de **[high] → [medium]** (mejorable, ya no bloquea).
- **Verdad cruda:** el lipsync de cabezas que hablan con Higgsfield/Seedance es **mediocre de por sí**. Ruta robusta = **minimizar habla-en-cámara**: para el testimonio de Rosa (su clip salía "uncanny + mal lipsync") la pusimos como **FOTO fija + médico en VOZ EN OFF** → **cero lipsync**. Rosa ya nunca habla en cámara.
- Invariante `lipsync-voz-nativa` **actualizado** (voz nativa + cuidar pronunciación en el prompt + si la cara que habla sale fea → b-roll/foto + voz en off) y sincronizado a CLAUDE.md.

### 2. 🧑 Persona realista (no "alien") — ruta UGC = soul_2 + VERIFICAR
- nano_banana / modelos genéricos salen con look **"AI liso / alien"**. **Higgsfield SOUL (`soul_2`)** da humanos creíbles con **piel real** (poros, textura). El owner cortó en seco una cara fea ("la imagen está horrible, ¿no te das cuenta?") → lección: **VERIFICAR la cara con ojo crítico ANTES de usar/animar**; "funciona técnicamente" ≠ "se ve bien".
- Invariante `persona-ruta-ugc` **actualizado** (usar soul_2 + verificar-no-alien; el enhancer de soul_2 neutraliza la expresión → la sonrisa se logra al animar) y sincronizado.

### 3. 🔁 Continuidad antes/después (CRÍTICO del gate) — EDITAR > GENERAR
- El gate marcaba **[critical] "inconsistencia de persona antes/después"**. Generar cada estado por separado fallaba (drift de identidad/edad + el enhancer de soul_2 ignora la hinchazón).
- **Solución que funcionó (aprobada por el owner):** tomar UNA foto realista (`rosa-final.png`, soul_2 con `rosa-hinchada` como referencia de identidad) y **EDITARLA con `nano_banana_2` en modo edición** para variar SOLO la hinchazón → **3 estados de la MISMA persona**: `estado1_hinchada.png` → `estado2_media.png` → `estado3_renovada.png` (progresión "va mejorando"). Montaje `prog_comparativa.png`. **Aprendizaje:** para variar un mismo sujeto, **editar una foto base** (identidad garantizada + control) en vez de generar cada estado.

### 4. 🏷️ `backgroundColor` en el compositor (etiqueta legible)
- Nuevo campo opcional en `CompositeElementVisual` (kind `text`): fondo sólido → etiqueta de producto / lower-third que **TAPA el texto basura** del empaque generado. Cableado en `scene.schema.ts` → `PlanoEscenas.tsx` → `block.ts` → `proto-key.ts`. Typecheck verde. (El gate elogió la etiqueta: "bien ejecutado".)

### 5. 🐛 BUG real de robustez arreglado — split-brain de storage
- `apps/web/lib/paths.ts`: `REPO_ROOT` hacía `resolve(cwd,'..','..')` (asumía cwd=`apps/web`). Un **script corrido desde la raíz** escribía el storage en **`C:\Users\cmktc\storage`** (¡fuera del repo!) — por eso los reportes del gate "no aparecían". Ahora `findRepoRoot()` **sube hasta `pnpm-workspace.yaml`** → siempre dentro del repo, sin importar el cwd. Verificado (`STORAGE_DIR` resuelve dentro del repo). La app no cambia (usa `VF_STORAGE_DIR`).

### 6. ⚠️ Gap pendiente (Fase 2) — el pipeline AUTOMÁTICO aún superpone TTS
- La regla de audio nativo está **documentada** pero `pipeline.ts` todavía genera **UN solo `audio.mp3` (TTS)** y lo monta sobre clips muteados. Para que la herramienta aplique el lipsync nativo **sola** falta: audio nativo por segmento que habla (multi-voz) en `scene-animator`/`pipeline`. **Es el "bake-in" pendiente.**

### 7. ▶️ Estado del video + PRÓXIMO PASO INMEDIATO
- **Render actual:** `storage/proto-composite/supercalm-key6.mp4` (~15 MB, ~23s): médico hook (voz nativa) + teaser producto → Rosa ANTES (foto + círculos ojeras/papada + médico voz off) → Rosa DESPUÉS (foto realista + médico voz off) → producto con etiqueta.
- **Gate:** **FALLA** pero **bajó de 7 → 3 bloqueantes**. Restantes: (1) **[crítico] persona inconsistente antes/después** → lo resuelven los **3 estados recién aprobados**; (2) **[alto] formato/dinamismo** → es **estructural**: un tramo de 24s NUNCA "pasa" comparado contra el ad COMPLETO de 72s (no es arreglable sin hacer el ad entero); (3) producto poco visible en un punto.
- **HACER AHORA:** cablear en `proto-key.ts` los 3 estados como progresión real → **escena ANTES = `estado1_hinchada.png`**, añadir un beat **INTERMEDIO = `estado2_media.png`**, **DESPUÉS = `estado3_renovada.png`** (reemplaza `rosa-final.png`/`rosa-hinchada.png` para que TODO sea la misma mujer). Re-ajustar posición de círculos a la cara nueva del "antes". `npx tsx scripts/prep-key.ts` → render → `scripts/run-quality-gate.ts --render ... --original "...V2.mp4" --gemini`. *(El owner pidió "solo las imágenes" primero; ya están y aprobadas.)*
- **Créditos Higgsfield:** ~27 de 4962 esta sesión (cuidar créditos sigue vigente — generar lo mínimo).

### 8. Reglas reforzadas (esta sesión)
- **VERIFICAR siempre lo VISUAL** (ver la cara/el frame) antes de seguir; el owner detecta "alien"/feo que el gate de texto no.
- **soul_2** para humanos UGC; **editar foto** para variar un mismo sujeto.
- Honestidad: el gate seguirá marcando "infidelidad de formato" en tramos parciales — decirlo, no esconderlo.

---

## 🚀 VERSIÓN 6 — 03-06-2026 (Compuerta de calidad video+audio + "Estilo CapCut" + manual de activaciones)

> **Foco de la sesión:** aprender/reproducir formatos de video complejos (ej. ad del médico SuperCalm) y, sobre todo, que la herramienta **se autocritique antes de entregar**.

### 1. 🛡️ Compuerta de calidad (LO GRANDE — el "norte" de esta sesión)
Antes, el único recurso que VE+OYE video (Gemini, `ad-analyzer`) se usaba solo para APRENDER, nunca para juzgar lo generado → el lipsync/realismo malos se colaban. Se construyó la **compuerta**:
- `apps/web/lib/kb/quality-gate.ts` — `runQualityGate`: corre el panel `format-audit` + (opt-in) el **juez Gemini video+audio** sobre el render, deriva veredicto **determinista** `pass/revisar/fail` (`decideGateVerdict`, función pura) + **fail-closed** (si el juez AV no evalúa, NO aprueba a ciegas). Deriva una **rúbrica del formato** (`deriveRubric`) con las invariantes como criterios. Persiste (`writeQualityGateReport` en `findings.ts`).
- `apps/web/lib/render-quality-judge.ts` + `apps/web/lib/gemini-video-transport.ts` — el **juez que VE+OYE** el render (8 dims: realismo, **lipsync**, fidelidad, ritmo, producto, **hinchada-vs-golpeada**, recorte, anotación). Transporte = el de `ad-analyzer` generalizado (inline/File API/GCS, fallbacks).
- **Enganchada a la pipeline** (`pipeline.ts`, best-effort, no bloquea) con **`VF_GATE_ON_RENDER=1`**. CLI: `scripts/run-quality-gate.ts` (exit 0/1/2). Juez Gemini: `VF_GATE_USE_GEMINI=1`.
- **Verificado:** 13 tests (`node:test`, `pnpm tsx --test apps/web/lib/kb/quality-gate.test.ts`) + `pnpm -r typecheck` verde + **probado end-to-end: reprobó un render malo** y cazó lipsync/grotesco/producto/narración.
- **Pendiente:** (a) mostrar el veredicto en la **UI del run** (hoy persiste+loggea), (b) **bucle de auto-reparación** (interfaz `RepairLoop` diseñada, NO implementada — fase 2).

### 2. 📋 Manual de activaciones (para el manual de usuario)
`docs/manual-activaciones.md` — registro de TODO lo activable que se puede olvidar: flags `VF_*`, keys requeridas, capacidades NO enganchadas (compuerta/format-audit), opt-in por preset, pasos manuales. ⚠️ **Ojo:** hay UNA excepción real a "nada se auto-aplica" → `apps/web/lib/auto-fix.ts` puede escribir código `.ts` si `confidence≥85` y se procesa la cola (OFF por defecto). Revisar con el owner.

### 3. 🧠 6 invariantes nuevas (en `CORE_INVARIANTS` + sync a CLAUDE.md)
`persona-ruta-ugc` (personas = video UGC real, NUNCA animar foto sobre verde), `lipsync-voz-nativa` (voz nativa del clip + escenas cortas, no TTS encima), `anotaciones-ancladas-sincronizadas`, `sin-subtitulos-salvo-pedido`, `usuaria-antes-hinchada-progresion`, `validators-detectan-y-usuario-corrige`.

### 4. 🎬 "Estilo CapCut" / reproducir formatos
- VISUAL = **ruta UGC** (Higgsfield/Veo, escena real; `docs/analisis_videos_ugc.md`, `investigacion/RUTA-IGUALAR-ESTILO.md`). NO animar retratos sobre verde. El recorte/PiP = matting o caja (aparte, después).
- TÉCNICO (edición) = compositor Remotion (`FreeformComposite`): PiP, recorte chroma→webm alpha, anotaciones, captions (`textColor` nuevo en `CompositeElementVisual`), 2 voces. Protos: `proto-sc20.ts`, `proto-ugc-edit.ts`, `proto-supercalm.ts`. Scripts: `tts-supercalm`, `prep-*`, `detect-cuts` (micro-escenas/cortes), `extract-frame`.
- Formato aprendido: `docs/formato-supercalm-doctor-split.md` + receta `docs/supercalm-doctor-receta-ejecucion.md`.

### 5. ▶️ Próximo paso inmediato (el video SuperCalm)
Reproducir bien los ~20-30s del ad del médico. La compuerta ya marcó qué arreglar: **(a)** sección "**después**" de Rosa (progresión de mejora), **(b)** **producto legible**, **(c)** **lipsync** (audio nativo del clip + escenas cortas), **(d)** **anotaciones sincronizadas** a la palabra. Iterar: generar → compuerta verifica → corregir lo que falla. *(Assets en `storage/proto-*`, gitignored.)*

### 6. Reglas reforzadas del owner (esta sesión)
- ⛔ **NO subtítulos** salvo que el owner los pida.
- Personas SIEMPRE por la **ruta UGC** (no retrato animado).
- **Honestidad:** no decir "listo" si no está bien; verificar (ver+oír) antes de entregar.
- **Cuidar créditos de Higgsfield** (generar lo mínimo hasta liberar).

---

## 🚀 VERSIÓN 5 — 01-06-2026 (Rediseño front + español neutro total + Consejo de mejora continua + Memoria viva)

> **LEER PRIMERO: las `## Invariantes del proyecto` al inicio de `CLAUDE.md`** (memoria viva,
> reglas duras + wirings no-obvios). Evitan re-descubrir y repetir errores.
> **Puntos de retorno (commits locales, sin push):** tag `pre-admin-redesign` → `3f9faf9`
> (rediseño + voseo en la IA) → `d232786` (pantallas secundarias + voseo) → `9e8503d`
> (Consejo Entrega 1). El bloque "Memoria viva + botón + explicaciones admin" va en el
> commit de esta sesión.

### 1. Rediseño del front (premium oscuro, legible)
- **Bug crítico resuelto:** la fuente caía a **Times New Roman** (serif) porque el CSS apuntaba a
  `var(--font-inter)` (inexistente). Ahora **Inter** (estilo Apple; SF real en equipos Apple) vía
  `var(--font-sans)` en `tailwind.config.ts` + `layout.tsx`. Base **17px** (`globals.css`) y barrido
  de ~128 textos px→clases escalables para legibilidad.
- Sistema de diseño: `components/ui/{card,button}.tsx` (shadow-elevation, tactile), `Sidebar.tsx`
  (tokens + acento violeta), `globals.css` (atmósfera). "Mis videos": tarjetas con miniatura real
  (cualquier video terminado, no solo `completed`) + estado en español con color (`RepositoryView.tsx`).
- **Español neutro TOTAL:** eliminado el voseo de UI **y de los prompts de la IA** (validador, editor,
  jueces, chat, scene-planner, mensajes de error) — ~167 correcciones. También "acá"→"aquí" y
  "Discutí"→"Discute". Verificado: grep en `.tsx` y `.ts` → solo quedan las listas de "formas
  prohibidas" intencionales.

### 2. Consejo de mejora continua — Entrega 1 (commit 9e8503d)
Evolución del `deepAudit` (orquestador → especialista/subsistema → verificador → IA superior).
- **Análisis continuo agrupado:** `apps/web/lib/kb/auto-audit.ts` → `maybeAutoAudit()` (fire-and-forget
  al terminar un run en `pipeline.ts`). Dispara `deepAudit()` cada N runs o X horas. **Control: BOTÓN
  en /admin** (persistido en `storage/kb/auto-audit-config.json`) o env `VF_AUTO_AUDIT=1` (override).
  **OFF por defecto** (el owner lo enciende).
- **Alimentar el Cerebro:** el bridge M9 (`system-log.ts`→`systemEventToKb`) YA reflejaba
  run-completed/failed a subsistema `pipeline`. Se llenó el gap del **validador** emitiendo
  `editor-ia-verdict` cuando el editor IA deja avisos. ⚠️ NO duplicar con emisores paralelos a
  `recordEvent` (ver invariante `kb-fed-by-system-log`).
- **Vista Consejo** en `/admin`→Cerebro (`KnowledgeAuditSection`): último informe (síntesis) +
  hallazgos agrupados por subsistema + botón encender/apagar. Persistencia: `findings.ts`
  `writeLastAuditReport`; `GET /api/admin/kb/audit` devuelve `{hallazgos,lastReport,auto}`.
- **Nada se auto-aplica** (Entrega 1 = observar/proponer).

### 3. Memoria viva del proyecto (invariantes)
- `apps/web/lib/kb/invariants.ts`: registro (`storage/kb/invariantes.jsonl`) + semilla
  `CORE_INVARIANTS` (7 reglas: español neutro, nada-auto-aplica, kb-fed-by-system-log, storage
  unificado, env-root, admin-gate, no-push).
- **Propagación:** inyectadas a la IA in-app vía `getSystemContextForPrompt()` (system-context) y
  sincronizadas a `CLAUDE.md` (sección "Invariantes", auto-cargada por sesión) con
  `npx tsx scripts/sync-invariants.ts`.
- **Admin:** explicación corta por pestaña (`TAB_HELP`) + pistas claras en las tarjetas de stats.

### 4. Próximos pasos sugeridos
- **Consejo Entrega 2 — cerrar el círculo:** que el Consejo proponga mejoras y, con OK del owner,
  las aplique (reutilizar `prompt-evolution.applyPatch`) → marcar hallazgo `arreglado`.
- **Alimentar** `image-gen`/`animacion`/`compositor` (subsistemas sin kinds en `systemEventToKb`).
- Que el owner **agregue invariantes desde /admin** (hoy: por código `addInvariant` o las propongo yo).
- (Hygiene) limpiar `apps/web/storage` viejo duplicado (el storage vivo es `/storage`).

---

## 🚀 VERSIÓN 4 — 01-06-2026 (UX rework + Copilot guiado + a la carta + seguridad + Base de Conocimiento)

> Sesión muy larga. TODO verificado (typecheck monorepo verde + 77 tests + pruebas en vivo).
> **Commits locales (sin push), puntos de retorno:** `6b7f954` (V3) → `1c3ec8d` (UX+Copilot+a la carta+seguridad) → `4a2c0c0` (storage unify + M5 + spec Cerebro) → `66b983a` (KB Fase 0).
> Para retomar: **chat nuevo** → "lee HANDOFF.md + CONOCIMIENTO.md y seguimos".

### 1. UX re-work (commit 1c3ec8d)
- **Tema oscuro** forzado: `app/globals.css` (paleta `.dark`) + `app/layout.tsx` (`className="dark"`).
- **`components/Sidebar.tsx`** (nuevo): nav agrupada (Mis videos/Marcas/Asistente IA/Aprendizaje/Admin) + botón **"＋ Crear video"** que abre un **modal** (Desde cero → `/create`, Ripear → `/rip`). Cierra con Escape.
- **`components/PageHint.tsx`** (nuevo): `PageHeader` + `PageHint` (cartelito "para qué sirve"). Aplicado a TODAS las páginas de `(app)/`.
- **Asistente IA** = `(app)/sugerencias/page.tsx` reescrito como **3 modos/tabs** (Ideas / Aprender estilo / Técnico). `/arquitecto` → `redirect('/sugerencias')`.
- `(app)/layout.tsx` monta `<Sidebar/>` + `<CopilotWidget/>`.

### 2. Copilot flotante (commit 1c3ec8d, refinado en 66b983a)
`components/CopilotWidget.tsx` + `lib/claude-chat-discuss.ts` (contextType **'copilot'**).
- **Muralla de datos:** al copilot NO se le inyecta `getSystemContextForPrompt()` (proveedores/claves). SÍ se le inyecta un **catálogo de cara al usuario** (`buildCopilotCatalog`: marcas + presets con ids reales) para armar briefs.
- **Brief guiado:** el copilot emite un bloque oculto `[[BRIEF]]{script,brandId,presetId,voice,subtitles,animation,kenBurns}[[/BRIEF]]` → botón **"✅ Crear este video"** → escribe `sessionStorage` (`prefill-script` + `prefill-options`) → `window.location.assign('/create')` → `CreateForm` lo prellena (incl. los toggles).
- **Sugerencias a admin:** bloque `[[SUGERENCIA]]{titulo,descripcion,categoria}[[/SUGERENCIA]]` → auto-guarda a `/api/sugerencias`. Se ofrece también cuando la herramienta NO puede hacer algo.
- **Historial POR USUARIO:** `/api/copilot/conversations` (GET lista/single, POST guarda) por `userId` (localStorage `vf-user-id`). `convIdRef` (id de cliente) evita duplicados. UI: "Ver conversaciones pasadas" + "Nueva".
- **Estilo:** `renderRich` (negrita `**`), emojis, **compostura** (no suplica al ser molestado), **saneador de voseo** `toNeutralSpanish` (`VOSEO_MAP` — SOLO formas inequívocas; NO rompe "salí/sentí/SOS"), nudge 30s, chips (1º = "🎬 Quiero hacer un video"), regla NO-roles ("usuario/administrador"), extrae lo relevante de chats pegados.
- **Registro de chats:** `lib/chat-log.ts` → `storage/chat-logs/chats.jsonl` **+** (Fase 0 KB) `recordEvent`.

### 3. Opciones "a la carta" en Crear (commit 1c3ec8d)
`CreateForm.tsx` → `/api/generate` → `pipeline.ts` overrides:
- Toggles **Voz / Subtítulos / Animación / Ken Burns** → `skipVoice` / `subtitlesZapcap` / `disableAnimation` / `kenBurns`.
- **Sin voz** = pista muda (`audioTrack.filePath=''`, duración estimada) + `<Audio>` **condicional** en las 3 composiciones del compositor. NO se cae.
- Subtítulos backward-compat: `undefined` respeta el preset (no lo pisa).

### 4. Micro-escenas SELECCIONABLES + preview (commit 1c3ec8d)
- `expandEnumerationScenes(scenes, words, {}, allowedSceneIndices)` — null=todas, []=ninguna, [i]=esas. +2 tests.
- **Preview:** `/api/plan-preview` corre solo script-processor+scene-planner (barato), devuelve `{previewId, scenes}` y **persiste el plan** en `storage/previews/`. La generación lo **reusa** (`overrides.reusePlanId`) → índices estables. Guard fork (`wantMicro && !isForkedRun`).

### 5. Seguridad + resiliencia (commit 1c3ec8d + 4a2c0c0)
- **Auth** agregado a `/api/chat/discuss`, `/api/sugerencias`, `/api/debug/env-check` (+ quitado el leak del prefijo de API keys). El middleware NO cubre `/api/*`; cada ruta se auto-chequea.
- **TTS fallback ElevenLabs→OpenAI ante CUALQUIER error** (antes solo cuota/auth) — `pipeline.ts` ~292.
- **M5** (`post-render-judge/judge-final.ts`) usa la **duración REAL** del audio (`audioDurationSec` que pasa el pipeline) en vez de estimar por tamaño.

### 6. Storage UNIFICADO (commit 4a2c0c0) — ⚠️ activa al reiniciar dev
- **Problema (era):** la memoria de aprendizaje se partía entre `apps/web/storage/` (runtime, vía `process.cwd()`) y `storage/` raíz (paths.ts). "Split-brain".
- **Fix:** `next.config.mjs` setea `process.env.VF_STORAGE_DIR = <root>/storage`. `preset-judgment-memory`, `prompt-evolution`, `system-log`, `paths.ts` lo respetan (fallback cwd para scripts).
- **Datos migrados** (COPIADOS, originales intactos): `preset-memory` (9 juicios) + `prompt-patches` (4 parches) → `storage/`. **Se activa al próximo reinicio del dev server.**

### 7. Base de Conocimiento — Fase 0 ✅ COMPLETA (recolección + ruteo de emisores)
- Spec completa: **`CONOCIMIENTO.md`** (léela). Es el "Cerebro Obsidian": todo registrado+ubicable, agentes especialistas + IA superior on-demand, evoluciona con el uso, **solo la recolección es automática**, nada se auto-aplica.
- **Cimiento:** `lib/kb/record.ts` (`recordEvent` + esquema `KbEvento` + índice `storage/kb/indice/por-entidad.json`). `codeVersion`=git short hash para frescura.
- **Los 6 emisores cableados a `recordEvent` (todos best-effort, nunca rompen el flujo):**
  1. **chat** — `chat-log.ts` → tipo `chat` (sesión previa).
  2. **system-log** — `logSystemEvent` rutea genérico → tipo `run-evento` (`systemEventToKb` mapea `kind`→subsistema/vault/severidad + extrae `entidad` de `data`). **Cubre también "pipeline run-success/failed"** porque el pipeline ya emite run-completed/run-failed por logSystemEvent CON métricas (costUsd, imageCount, durationSeconds) — no se duplicó hook.
  3. **juicio-preset** — wrapper nuevo `lib/kb/emitters.ts` (`recordPresetJudgmentKb`) envuelve a `recordPresetJudgment` (vive en packages/core, no puede importar apps/web) → tipo `juicio-preset`. **4 call sites migrados:** pipeline run-success/used-for-rip/run-failed + `/api/admin/presets/[id]/approve`.
  4. **sugerencia** — `/api/sugerencias` → tipo `sugerencia` (vault producto, subsistema ux).
  5. **feedback** — `owner-feedback.recordIntervention` → tipo `feedback` (la señal más valiosa; entidad runId/sceneIndex/brand/preset).
- **Anti-duplicados (clave):** `systemEventToKb` SALTA `chat-discuss-message` (lo cubre chat-log como `chat`) y `suggestion-posted` (lo cubre /api/sugerencias como `sugerencia`). Así cada acción real = 1 evento bien tipado.
- **Verificado a fondo:** `pnpm -r typecheck` monorepo VERDE (19/19). Prueba en vivo: POST /api/sugerencias → 1 evento `sugerencia` y 0 duplicados (skip OK); script tsx → system-log genérico escribe `run-evento` con entidad extraída + skip de chat confirmado. **Toda la data de prueba fue limpiada** (KB quedó con los 3 eventos de chat reales). Sin commit aún (pedir al owner).
- **Fase 1 ✅ COMPLETA (consulta + vista):** `lib/kb/query.ts` → `query(filtros)` (vault/subsistema/tipo/entidad/tag/estado/desde/hasta/limit, orden ts desc, lectura dirigida por subsistema) + `kbStats()` (agregados) + `buildContextFor(scope, maxChars=4000)` (digest CHICO pre-digerido + truncado = el ahorro). Endpoint `GET /api/admin/kb` (auth) y sección visible **"🧠 Base de Conocimiento"** en `/admin` (`AdminPanel.tsx`, siempre visible aunque no haya presets pendientes). `record.ts` ahora exporta `EVENTOS_DIR`. `buildContextFor` queda listo para que lo consuma `deepAudit` (Fase 2); NO se inyecta al Copilot (muralla de datos). Notas `.md` Obsidian: pospuestas (opcional, bajo valor hoy).
  - **Verificado:** typecheck monorepo VERDE; `GET /api/admin/kb` en vivo (stats + 3 eventos chat, orden correcto); script tsx de `query()`/`buildContextFor()` (filtros, limit, orden, truncado) — todo OK, KB intacta (read-only).
- **Fase 2 ✅ COMPLETA (auditoría profunda on-demand):** `lib/kb/deep-audit.ts` → `deepAudit({subsistemas?, depth, force?, maxVerificaciones?, deps?})`. Pipeline estructurado EN LA APP (no usa el Agent/Workflow del harness; usa `unifiedJudge`): orquestador (elige subsistemas con actividad o el scope; **caché por codeVersion+ts** salta lo sin cambios = ahorro §8) → especialistas adversariales 1×subsistema (con `buildContextFor`, briefs de dominio) → verificador adversarial refuta high/critical (mata falsos positivos) → IA superior sintetiza (dedup/ranking/próximo paso). **NUNCA auto-aplica.** Persiste en `lib/kb/findings.ts` (`storage/kb/hallazgos/findings.jsonl`, con `estado` = bucle de resultado) + refleja los hallazgos vivos a la KB (`tipo:hallazgo-auditoria`). `depth`: rapido=Haiku / profundo=Sonnet-4-6. Esquemas Zod **truncan en vez de rechazar** (evita el bug histórico del validator que perdía output por longitud). UI: sección **"🔍 Auditoría profunda"** en `/admin` (botón on-demand) + endpoints `POST/GET /api/admin/kb/audit`. `record.ts` exporta `getCodeVersion`.
  - **Verificado:** typecheck monorepo VERDE (19/19) + test aislado con **mocks** (cero API): orquestación (2 especialistas → 2 verif, las low se saltan → 1 síntesis = 5 llamadas), verificador mata 1 falso-positivo, persistencia (findings 3 líneas) y reflejo a KB (solo los 2 vivos) — todo OK, KB real intacta. **Falta la 1ª corrida REAL paga**, que dispara el owner desde el botón (por diseño on-demand). Commit local `85f2571` (sin push).
- **SIGUIENTE → Fase 3:** curación/evolución + Capa 5. Bucle de resultado: UI para marcar hallazgos `confirmado`/`falso-positivo`/`arreglado` (la lib `updateHallazgoEstado` ya existe) → cada especialista recibe sus hallazgos confirmados previos + su tasa de falsos-positivos (afina solo). Curación: subir/bajar `confianza` por repetición/confirmación. Capa 5: IA que **propone ideas y anticipa** sobre la base curada (cruza con `IDEAS.md`). (Opcional pendiente: notas `.md` Obsidian; correr la 1ª auditoría real.)

### 8. Onboarding + distribución "de cara al usuario" ✅ base (commit local de esta tanda, sin push)
- **Doc que lo gobierna: `HANDOFF-USUARIO.md`** (raíz) — guía VIVA de instalación, distribución local-first, keys/prereqs y el buzón+sync. **Regla:** actualizarlo en el MISMO commit cuando cambie una key/prereq/onboarding/sync (ya enlazado desde `CLAUDE.md` §continuidad).
- **Modelo decidido:** LOCAL-FIRST para EMPLEADOS (bajo contrato → sin bloqueo legal/privacidad). Cada empleado corre la app en su máquina (su disco, su compu hace los videos) → **esquiva los problemas de storage + jobs largos de la web**. El owner solo hospedaría un "buzón central" chico para el aprendizaje.
- **Cimientos construidos (typecheck monorepo VERDE + `/api/onboarding/status` probado EN VIVO devolviendo solo booleanos):**
  - `apps/web/lib/kb/sync.ts` — cliente de sync OPT-IN al buzón central. **OFF por defecto** (no-op si no hay `VF_LEARNING_SYNC_URL`), best-effort (nunca lanza), manda solo `KbEvento` (NUNCA videos/imágenes/keys), cursor en `storage/kb/sync-cursor.json`, lotes de 500. Exporta `isSyncConfigured()` + `syncPendingEventos()`. NO cableado a correr automático aún.
  - `GET /api/onboarding/status` — checklist PÚBLICO (pre-auth, por el huevo-gallina del primer arranque): presencia BOOLEANA de keys/prereqs/ffmpeg/db + si sync configurada. **NUNCA expone valores de keys** (verificado en vivo). HIGGSFIELD/KLING chequean el par completo.
  - `/onboarding` (`page.tsx` + `layout.tsx`, fuera del grupo `(app)`, público) — checklist visual en español neutro.
  - `.env.example` completo + comentado (fuente única de keys); `middleware.ts` (solo comentario: `/onboarding` público a propósito, matcher sin cambios).
- **Receptor central + clave de admin + dashboard ✅ (commit de esta tanda):** **Clave de admin** `ADMIN_PASSWORD` (separada de APP_PASSWORD) candá `/admin` (login `AdminLogin.tsx` + `POST /api/admin/login` → cookie `admin_auth`) y TODOS los `/api/admin/*` (gate central en `middleware.ts` → 401 sin la cookie); `lib/auth` isAdmin/checkAdminPassword/setAdminCookie. Receptor `POST /api/sync/ingest` (token `VF_SYNC_INGEST_KEY`) + `lib/kb/central-store.ts` (almacena por instalación en `storage/kb/central/`); trigger `syncPendingEventos()` al completar run (pipeline, opt-in/no-op); dashboard `GET /api/admin/central` + sección **"📊 Costo por usuario"** en `AdminPanel.tsx` (costo-eficiencia; costo = **ESTIMADO**, subcuenta clips). **Verificado en vivo:** flujo del gate (401 sin clave → 401 clave mala → 200 clave OK → dashboard 200 con datos) + typecheck VERDE + tests aislados. `ADMIN_PASSWORD` temporal puesta en el `.env` del owner (cambiar). El viejo `VF_ROLE` quedó eliminado.
- **Pendiente:** (a) el receptor debería **deduplicar por `id`** (sync reenvía 1 evento del borde, off-by-one inofensivo, `query` usa `desde` inclusivo); (b) **deploy del receptor** a URL alcanzable (hoy local/misma red); (c) costo EXACTO (telemetría per-proveedor); (d) wizard de keys interactivo; (e) `/brands` middleware (pre-existente).

### ⚠️ Pendientes / decisiones honestas (de las auditorías adversariales)
- **Mixeo cross-usuario NO existe** — es prematuro (hoy ~22 datos de 1 usuario). El cerebro evolutivo M7 SÍ existe y agrega ENTRE runs (no entre usuarios). La KB es el prerequisito.
- **`lib/validator-chat-ia-preflight.ts` = CÓDIGO MUERTO** (validador proactivo construido, sin cablear). Decidir: cablear o borrar.
- **Gap de categorías del validator:** `asset-mismatch`/`style-drift` están en el prompt pero NO en el enum Zod (`validator-chat-ia.ts` ~206) → caen a 'other' y se saltan el strict-guard. Cirugía + verificar con generación real.
- **Un verdict "wrong" del validator NO bloquea la escena** (es advisory; el escape-hatch entrega el video igual). Decisión de producto.
- **NO se corrió una generación REAL** con el código nuevo (toggles/skipVoice/plan-reuse/brief): typecheck+tests+lógica OK, pero falta una corrida pagada para confirmar e2e.
- Lint cosmético (`no-unescaped-entities`) — solo importa para build de producción.
- **Video clorofila** (con el socio): parado. Necesita el script de Slack + una referencia visual del estilo "cartoon visceral".

### 🔁 Verificación rápida
- `pnpm -r typecheck` = verde. Tests: word-sync 19, image-gen-multi 10, scene-planner 6, compositor 21, image-gen-imagen 21 (**77**).
- Dev en `localhost:3000`, cookie `app_auth=valid`. Hay 2+ `next dev`: NO levantar otro (chocan en `.next` → 500). Un solo server.

### 📏 Reglas (recordar)
- **Español neutro SIEMPRE, JAMÁS voseo** (regla #1 del owner). Verificar cada texto.
- **NUNCA `git push`** sin pedido explícito. Commits locales OK. `storage/` y `.tmp*` gitignored.
- Nada destructivo ni se auto-aplica al código sin consentimiento.

### 📄 Documentos de referencia
- `ARQUITECTURA.md` — doc maestro vivo del sistema (leer primero para contexto técnico).
- `HANDOFF.md` — este archivo: estado WIP, bugs activos, próximos pasos de desarrollo.
- `investigacion/99-PLAN-FINAL.md` — plan de fix de la cascada de providers.
- **`HANDOFF-USUARIO.md`** (raíz) — onboarding de empleados, prereqs, keys, buzón de sync.
  Mantenerlo actualizado junto con los cambios de keys/prereqs/código.

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
