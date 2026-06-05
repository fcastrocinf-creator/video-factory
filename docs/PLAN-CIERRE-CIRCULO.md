# Plan: Cerrar el círculo de Video Factory — de "detectar" a "corregir solo"

> **Norte:** que la herramienta no solo VEA qué está mal en un video, sino que lo
> CORRIJA sola (con OK del owner) y reproduzca formatos complejos automáticamente.
> Hoy es un "crítico de cine": entiende y señala, pero las manos para editar las pone
> una persona. Le faltan las manos.

## Diagnóstico (verificado leyendo ~30 archivos del back-end, jun-2026)

El sistema implementa un **círculo de 8 pasos**. Está partido por la mitad:

| # | Paso | Estado | Dónde vive |
|---|------|--------|-----------|
| 1 | **Leer** (Gemini ve+oye el video real, no solo keyframes) | ✅ | `ad-analyzer.ts`, `render-quality-judge.ts` |
| 2 | **Entender** (panel de 6 especialistas) | ✅ | `kb/format-audit.ts` |
| 3 | **Detectar** defectos con evidencia | ✅ | `kb/quality-gate.ts` |
| 4 | **Proponer** el fix (lo guarda en la KB) | ✅ | `kb/findings.ts` (`fixPropuesto`) |
| 5 | **Mostrar** el hallazgo en el editor | ❌ | (se queda en la KB, no llega a la UI) |
| 6 | **Aplicar** la corrección dirigida | ❌ | `RepairLoop` en `kb/quality-gate.ts` = **solo tipos, sin implementar** |
| 7 | **Regenerar** solo lo que falla | ❌ | sin trigger; todo manual |
| 8 | **Aprender** para no repetirlo | ❌ | loop pasivo; `prompt-evolution.detectSystemicPatterns()` stub |

**Trampa arquitectónica clave:** el **motor (Remotion/`PlanoEscenas.tsx`) SOPORTA todo**
— PiP, chroma/cutout, anotaciones, multi-audio — **pero el pipeline automático
(`pipeline.ts`) NO lo EMITE**. Genera escenas estáticas + 1 TTS + animación cruda.
→ **Capacidad del motor ≠ autonomía del pipeline.** Cada parche manual del proto
`proto-key.ts` (audio nativo, círculos sincronizados, antes/después, packshot) es una
pieza que el pipeline debería emitir solo y no sabe.

Ceiling de automatización real hoy: ~70% para formatos simples, **~40% para el ad del
médico SuperCalm** (2 voces + PiP + antes/después + anotaciones).

## Fases (en orden de valor; cada una verificada antes de pasar a la siguiente)

### Fase 0 — Impregnar la comprensión (que no se pierda nunca)
- Nuevos invariantes en `CORE_INVARIANTS` (`apps/web/lib/kb/invariants.ts`) + sync a
  `CLAUDE.md` (`scripts/sync-invariants.ts`):
  - `circulo-leer-actuar`: el sistema percibe/detecta bien (1-4) pero le falta actuar
    (5-8); el norte es cerrar el círculo.
  - `motor-soporta-vs-pipeline-emite`: el motor aguanta PiP/chroma/anotaciones/multi-voz;
    el pipeline no los emite. Extender el pipeline para EMITIR, no rebuildear el motor.
  - `verificar-viendo-y-oyendo`: validar un render exige OÍR (transcribir el audio), no
    solo mirar frames. (jun-2026: se coló "la cara en chaqueta" por no oír.)
- `HANDOFF.md` Versión 8 con este diagnóstico + ruta.
- **Impregnado en la herramienta misma:** que el panel/gate detecte explícitamente estas
  situaciones (audio sin sentido, falta de PiP del experto, marca propia vs ajena) y las
  surfacee — la detección es el activo a blindar.

### Fase 1 — Mostrar (surfacear hallazgos al editor) [paso 5]
- Auto-correr el gate tras cada render (ya hay `VF_GATE_ON_RENDER`); persistir veredicto
  por run.
- Endpoint `GET /api/runs/[id]/gate` → hallazgos del último gate.
- Overlay en `CompositionEditor`: marcar sobre el canvas la zona/segundo del hallazgo
  ("audio dice 'chaqueta' @0–4s", "falta médico en PiP @ planos de Rosa").

### Fase 2 — Aplicar (implementar el RepairLoop) [paso 6]
- Implementar `planRepairs(report): RepairTarget[]` (el tipo ya existe): traducir cada
  bloqueante → acción determinista (regenerar imagen / reanimar / ajustar timing /
  surface-to-editor / escalate).
- Executor que aplica la acción **con OK del owner** (botón "Auto-reparar" por hallazgo).
- Invariante "nada se auto-aplica" intacto: siempre propone, el owner aprueba.

### Fase 3 — Auto-emit de composición (la causa de los parches) [la pieza grande]
- **Anotaciones sincronizadas automáticas:** conectar el `word-sync` (ya da timings de
  palabra) + detector de rasgos mencionados (ojeras/papada/…) → emitir `CompositeElement`
  `kind:'annotation'` con `startSeconds/endSeconds` y zona (idealmente con detección de
  cara). Esto AUTOMATIZA lo que hoy hago a mano en `proto-key.ts`.
- **Multi-voz por hablante:** refactor del TTS (`pipeline.ts`) para audio por `speakerId`
  (el campo ya existe en `scene.schema.ts`); el compositor mezcla por escena.
- **PiP automático:** que `scene-planner` emita `compositeLayout:'pip'` cuando detecta
  autoridad + testimonio simultáneos.
- **Audio nativo / lipsync** (el "bake-in" del HANDOFF V7): clip con voz nativa por
  segmento que habla, y **verificar pronunciación oyendo** (cuidado: "cara en chaqueta").

### Fase 4 — Regenerar dirigido + Aprender [pasos 7-8]
- Bucle `generar → juzgar → corregir → regenerar` usando el RepairLoop (con aprobación).
- Cerrar el aprendizaje: completar `detectSystemicPatterns()` → un defecto confirmado N
  veces refuerza el prompt del bloque (vía `prompt-evolution.applyPatch`, ya gated).

## Cómo se ejecuta
- **Por fases verificadas.** Cada fase: implementar → `pnpm -r typecheck` → `/run` (ver en
  la app) → si toca render, pasar el gate. Nada se auto-aplica sin OK del owner.
- **Empezar por Fase 0 + Fase 1**: dan valor inmediato (la comprensión queda grabada y los
  hallazgos por fin se ven en la UI) con bajo riesgo.
- Español neutro siempre. Sin `git push` sin orden. Sin subtítulos salvo pedido.

## Estado
- [x] **Fase 0 — Impregnar** ✅ (invariantes + CLAUDE.md + HANDOFF V8 + memoria + este plan)
- [x] **Fase 1 — Mostrar** ✅ (endpoint `/api/runs/[id]/gate` + `GateFindings.tsx` + `RunViewer`)
- [x] **Fase 2 — Aplicar (RepairLoop):** parte 1 ✅ (`planRepairs`) **+ parte 2 ✅ el "brazo"** (construido + verificado a nivel código; falta 1ª prueba real que gasta créditos):
  - **2.2a — sceneIndex en los hallazgos:** `HallazgoDraft`/`Hallazgo`/`GateBlocker` ganan `startSec`/`sceneIndex`; el panel (`format-audit`) y el juez (`render-quality-judge`) reportan el SEGUNDO del defecto; `runQualityGate` carga el `scene-plan.json` del run y mapea segundo→escena. `planRepairs` ahora emite `regenerate-image`/`reanimate` DIRIGIDOS cuando hay escena (camino seguro editor/escalar si no).
  - **2.2b — executor:** `repair-plan.ts` (puro: hallazgo→`CorrectionParse`) + `repair-executor.ts` (efectos: forkea + dispara). REUSA `applyCorrection` vía un `parseOverride` nuevo (salta el parseo NL de Gemini, targeting determinista). Cero motores paralelos.
  - **2.2c — gatillo con OK:** `POST /api/runs/[id]/gate/repair` (re-deriva del reporte persistido) + botón "🦾 Auto-reparar (con tu OK)" en `GateFindings`. Preserva el original (fork).
  - **Verificado:** `pnpm -r typecheck` 19/19 verde + 15 tests (`repair-loop` + `repair-plan`). **+ PRUEBA REAL end-to-end PASÓ** (run `568b8c8a`): gate con Gemini → 8 bloqueantes con `sceneIndex` real → endpoint `gate/repair` → fork `165f59b6` que regeneró SOLO la escena 6 (imagen+animación) y preservó el resto (hash MD5 idéntico) + audio bit-idéntico. Verificado viendo y oyendo.
  - **Límite honesto:** el brazo regenera la IMAGEN dirigida y re-renderiza; la re-animación automática solo corre para formatos `b-roll-animated`/`voiceover-animated` (heredado de `correction-pipeline`). Para clips UGC animados, regenera la imagen pero NO re-anima solo → refinamiento siguiente. El "audio del médico sin sentido" (TTS global) sigue siendo Fase 3 (multi-voz).
- [ ] Fase 3 — Auto-emit de composición (anotaciones vía word-sync, PiP, multi-voz/audio por escena)
- [ ] Fase 4 — Regenerar + Aprender (persistir `sceneIndex` en el hallazgo + `detectSystemicPatterns`)
