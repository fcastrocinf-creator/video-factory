# Receta de ejecución — Reproducir el ad SuperCalm (médico + Rosa)

Plan "listo para disparar". Cuando el owner libere presupuesto, esto se ejecuta sin re-pensar.
Base del formato: `docs/formato-supercalm-doctor-split.md` (72.47s · 13 escenas · 9:16 · 2 voces).

---

## ✅ MÉTODO PROBADO Y VERIFICADO (jun-2026, render `supercalm-key15.mp4`) — USAR ESTE

> Lo de más abajo (HeyGen / ElevenLabs) quedó **SUPERADO**. El owner aprobó este flujo. Invariantes: `lipsync-voz-nativa`, `pip-persona-corte-posicion`, `persona-ruta-ugc`, `verificar-viendo-y-oyendo`.

**Voz + cara que habla = Veo 3.1 (voz NATIVA). ⛔ NO HeyGen, ⛔ NO ElevenLabs, ⛔ NO Seedance.**
- El médico se genera con **Veo 3.1** (talking-head con diálogo nativo, vía el MCP de generación de Higgsfield): foto del médico (`medico-ugc.png` — UGC real en consultorio, soul_2) como `start_image` + la LÍNEA hablada EN EL PROMPT → devuelve al médico diciéndola con **lipsync real** (voz y labios del mismo modelo).
- ⛔ NUNCA un TTS de ElevenLabs encima del clip muteado (patina → la compuerta lo caza como "lipsync inexistente"). ⛔ Seedance audio-driven NO da lipsync (reference-driven). ⛔ Higgsfield DoP NO genera voz (solo movimiento).
- **2 clips Veo** (cada uno ≤8s; escenas cortas = mejor lipsync y ritmo):
  1. **Hook** (`medico-hook-veo.mp4`): *"Sientes la cara hinchada, con una papada marcada y mucha retención. Tienes que ver este caso."*
  2. **Off/explica** (`medico-off-veo.mp4`): *"Aquí observamos sus ojeras y su papada marcada. En pocas semanas, su rostro se ve más firme y definido."*
- **VERIFICAR OYENDO** cada clip (`scripts/transcribe-gemini.ts`) ANTES de montar — Veo también puede pronunciar mal.

**PiP del médico = CLIP con movimiento ("corte y posición"), NO foto fija.**
- El médico en el recuadro (mientras se ven los planos de Rosa) es el **clip OFF recortado y posicionado** (`rect` en `FreeformElement` video, muted). Tiene movimiento + lipsync a su voz nativa. Una foto fija (PiP o hook) = estático = el owner la rechaza.

**Audio = voz nativa concatenada (sin TTS externo).**
- `scripts/prep-key.ts` extrae el audio nativo de los clips Veo (`[hook][off]`) → `combined-key.mp3`. El compositor MUTEA los `<video>` y usa `combined-key.mp3` → el lipsync calza por construcción. Usar clips del MISMO modelo para TODA la voz del médico (consistencia de timbre).

**Montaje** (`packages/blocks/compositor-remotion/src/proto-key.ts`):
- Hook = clip Veo hook (full) + teaser del producto en esquina.
- Rosa ANTES (`estado1_hinchada`) → INTERMEDIO (`estado2_media`) → DESPUÉS (`estado3_renovada`), MISMA mujer (EDITAR una foto base, no generar cada estado por separado).
- Médico en **PiP** (clip off) durante TODO el tramo de Rosa.
- **Círculos** rojos en ojeras/papada SINCRONIZADOS a la voz del off (transcribir el off → "ojeras"@~1.8s, "papada"@~2.6s del clip).
- **Producto** (packshot REAL `packshot.jpg`) en esquina durante los resultados + cierre full CORTO (sin silencio largo).
- Sin subtítulos (regla del owner).

**Disparo:** 2 clips Veo (verificar oyendo) → `prep-key.ts` (audio nativo) → render `proto-key.ts` → **compuerta** (`scripts/run-quality-gate.ts --render <mp4> --gemini`, ve+oye) → iterar. Verificar VIENDO **y** OYENDO antes de dar por bueno.

> **Falta automatizar (cierra el círculo):** hoy esto se arma con `prep-key.ts`/`proto-key.ts` semi-a-mano. El siguiente paso es que el pipeline EMITA este formato solo (Veo por hablante + PiP corte-y-posición + círculos por word-sync) — ver `motor-soporta-vs-pipeline-emite` y `docs/PLAN-CIERRE-CIRCULO.md`.

---

## 0) Componentes a producir (3) — ⚠️ HISTÓRICO (HeyGen/ElevenLabs SUPERADO por el método de arriba)

| # | Componente | Cómo se genera | Costo |
|---|------------|----------------|-------|
| 1 | 🧑‍⚕️ **Médico hablando** (lipsync) | HeyGen `talking_photo` desde `storage/proto-composite/medico-base.png` + voz masculina ES + su guión | ~$1/min HeyGen |
| 2 | 👩 **Rosa en 3 estados** (antes→mejor→mucho mejor) | Imagen por estado (soul_2, ~0,12 cr c/u) → HeyGen `talking_photo` con su guión, O image-to-video + voz ElevenLabs | imágenes ~0 + HeyGen |
| 3 | 🧑‍⚕️ **Médico recortado (PiP)** | Del clip del médico (#1) → `prepareVideoCutout` (frames → keyer → webm alpha) → overlay en esquina | ~0 (local) |

> El médico de #3 es el MISMO clip de #1, recortado. No se genera aparte: se usa un tramo "asintiendo/escuchando" + sus bits hablados.

---

## 1) Guión separado por voz (lo que dice cada quien y cuándo)

### 🧑‍⚕️ MÉDICO (voz masculina ES, autoridad cálida)
- **0–4.9s (hook):** "Sientes la cara hinchada con una papada marcada y con mucha retención, entonces tienes que ver este caso que a mí me sorprendió mucho. Escucha atenta."
- **14.8–28.8s (explica):** "Así es como recibí a Rosa en la consulta. Les quiero explicar… Aquí podemos observar dos cosas impactantes: sus ojeras y su papada marcada, tal cual como te muestro. Lo que viene después me dejó sin palabras."
- **41.5–48.8s:** "Ahora mira el resultado después de un mes… parece una persona totalmente diferente."
- **56.8–72.5s (CTA):** "Increíble, ¿cierto? Si tienes el mismo problema que Rosa, te recomiendo hacer clic en el botón de aquí abajo y probarlo por ti misma. No te arrepientas. Te espero."

### 👩 ROSA (voz femenina ES, 50-60, casera)
- **6.8–14.8s (día 1, antes):** "Hola doctor, este es mi primer día antes de usar Nello. Le mandaré el otro video en 7 días más. Chaíto."
- **34–41.5s (semana 1):** "Hola doctor, llevo una semana usando Nello y me siento mucho mejor…"
- **48.8–56.8s (1 mes):** "Ya llevo un mes usando Nello… es algo totalmente recomendado."

---

## 2) Generación de Rosa (3 estados — prompts)

> Misma mujer (continuidad facial), 50-60 años, latina. Cambia su estado físico + entorno.

- **Estado A — día 1 (antes):** cara visiblemente **hinchada, ojeras marcadas, papada**, cansada; sostiene el pouch azul de Nello SuperCalm; baño con madera; selfie UGC casero, luz natural.
- **Estado B — semana 1 (mejor):** cara **menos hinchada**, mejor color; con una bebida roja; cocina de casa; UGC.
- **Estado C — 1 mes (mucho mejor):** cara **desinflamada, fresca, rejuvenecida**; suéter crema; sostiene el producto; UGC, sonríe.

(Para continuidad: usar la imagen del Estado A como referencia `medias` en B y C, o entrenar un Soul si hace falta consistencia fuerte.)

---

## 3) Timeline de ensamble (13 escenas — quién en pantalla, PiP, anotación, caption)

| t (s) | Plano | PiP médico | Anotación | Caption (amarillo) |
|-------|-------|-----------|-----------|--------------------|
| 0–4.9 | 🧑‍⚕️ médico full | — | imágenes superpuestas (hinchazón/papada/retención) | "sientes la cara hinchada…" |
| 4.9–6.8 | 🧑‍⚕️ médico | — | **flecha animada** sobre foto de Rosa | — |
| 6.8–14.8 | 👩 Rosa A (antes) | ✅ esquina inf-izq (asiente) | — | "hola doctor, mi primer día…" |
| 14.8–21.8 | 🧑‍⚕️ médico full | — | — | "así es como recibí a Rosa…" |
| **21.8–28.8** | 👩 Rosa A close-up | ✅ (señalando) | **🔴 círculos/flechas ROJAS en OJERAS + PAPADA** (ancladas a las zonas, sincronizadas a "sus ojeras y su papada") | "sus ojeras y su papada marcada" |
| 28.8–34 | 🧑‍⚕️ médico (sonríe) | — | — | — |
| 34–41.5 | 👩 Rosa B (semana 1) | ✅ | — | "llevo una semana… me siento mejor" |
| 41.5–48.8 | 🧑‍⚕️ médico full | — | — | "mira el resultado después de un mes" |
| 48.8–56.8 | 👩 Rosa C (1 mes) | ✅ | — | "ya llevo un mes… recomendado" |
| 56.8–72.5 | 🧑‍⚕️ médico full (CTA) | — | botón CTA abajo | "haz clic en el botón de aquí abajo" |

**Estilo captions:** amarillo `#FFFF00`, minúsculas, sans-serif bold heavy, abajo, con sombra negra.
**PiP:** recuadro inferior (≈ esquina izq), médico recortado (fondo borrado), asiente "sí" / a veces habla.

---

## 4) Pasos al "liberar" (orden de disparo)

1. **Médico (#1):** `generateHeyGenVideoAndWait` con `talkingPhotoId` (subir `medico-base.png` → talking_photo) + voz ES masculina + guión médico (4 segmentos). → `medico.mp4`.
2. **Rosa (#2):** generar 3 imágenes (soul_2) → 3 `talking_photo` HeyGen con su guión, O image-to-video + voz ElevenLabs. → `rosa_A/B/C.mp4`.
3. **PiP (#3):** `prepareVideoCutout(medico.mp4)` → `medico_cut.webm` (alpha).
4. **Ensamble:** construir `CompositeElement[]` con la tabla de arriba (timing por elemento, PiP `FreeformElement` video transparent, anotaciones kind `annotation` con zona+timing, captions). Render Remotion → `supercalm_render.mp4`.
5. **QA:** `runFormatAudit(original, supercalm_render.mp4)` → panel multi-agente compara y flaggea desviaciones (animación, voces, producto, anotación, fidelidad). Solo PROPONE.
6. **Última mano:** owner ajusta hablando (Copilot) o arrastrando (editor manual). Nada se auto-aplica.

---

## 5) Decisiones abiertas (para el owner)
- ¿Médico latino piel olivácea (recomendado, match marca ES) — pendiente aprobar la imagen base.
- ¿Rosa con HeyGen (lipsync perfecto) o UGC image-to-video + voz (más "casero")?
- Voces: voz HeyGen integrada o ElevenLabs (más control de timbre ES).
