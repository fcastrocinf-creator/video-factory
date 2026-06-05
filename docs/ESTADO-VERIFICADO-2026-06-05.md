# 🔎 ESTADO VERIFICADO — Video Factory (5-jun-2026)

> Generado tras **2 rondas de comprensión exhaustiva** (30 subagentes, ~4M tokens, un crítico
> independiente instruido para ser estricto dictaminó **COMPLETO**). **Verificado por LECTURA del
> código, NO ejecutado** (no se gastaron créditos; la verificación dinámica en vivo queda fuera).
> **Donde este doc contradiga a otros, manda este** (ver §4 Docs stale). Es una foto del estado
> real para que el próximo chat arranque con la verdad, no con docs atrasados.

---

## 1. Estado real por subsistema

| Subsistema | Estado | Hueco / nota clave |
|---|---|---|
| **pipeline** (`apps/web/lib/pipeline.ts`, ~2700 líneas) | Funcional, no probado e2e en esta sesión | Monolito de ~13 etapas. Emite escenas + 1 TTS + animación cruda; **NO emite composición compleja**. |
| **Modos Crear / Ripear / Aprender** | Cableados | Aprender tiene 3 sub-flujos solapados (one-shot, iterativo, trainStyle) con 2 mapeadores distintos (Gemini vs Claude). Textos de UI engañosos sobre "aprende solo". |
| **Guion + voz (TTS) + word-sync** | Funcional (tests verdes) | Subtítulos DESACTIVADOS por el owner. Multi-voz NO emitida. Voz nativa Veo/lipsync vive en scripts/proto, no en el pipeline. |
| **Imagen (image-gen-multi + providers)** | Funcional | Cascada OpenAI→Gemini→Vertex→AIStudio→Higgsfield→fal con validación V3 + juez Claude. `fastMode` DESACTIVA el sequence-validator. Flow legacy de 1 imagen NO valida. |
| **Animación (scene-animator: Higgsfield/Kling/Veo)** | Funcional, con **grieta de gate** | `isAnimatedFormat` = solo `b-roll-animated`/`voiceover-animated` → **los presets `ugc-*` NO se animan** (ver §2). Saldo agotado de Higgsfield no se maneja (flag existe, no se consume). |
| **scene-planner + timing** | Funcional | Timing por char-count (aproximado); el fix real (word-sync) solo con ElevenLabs. Bug de duración persiste en cache-hit/fallback. |
| **Compositor / motor Remotion** | **Funcional-probado** (21 tests + typecheck) | SOPORTA PiP/chroma/anotaciones/fundidos/multivoz. ComposicionAvanzada = código muerto (superado por FreeformElement). |
| **Compuerta + jueces** | Cableado + test guardián | Corre SIEMPRE (await, useGemini:true). Rúbrica por formato NO llega desde el pipeline (usa criterios genéricos). Guardián de voseo añadido. |
| **Brazo de auto-reparación (Fase 2)** | **COMPLETO a código** (contradice docs viejos) | `planRepairs`→`executeGateRepair`→fork+`applyCorrection`. Falta la 1ª prueba real con créditos + el paso 8 (aprender). Solo repara b-roll/voiceover. |
| **KB / cerebro / Consejo** | Recolección viva; auditoría OFF | `deepAudit`/`auto-audit` nunca corrieron (OFF por defecto). Bridge M9 no cubre image-gen/animación/compositor. |
| **Validador / chat IA (prioridad #1)** | Muy desarrollado | Gate por clip (Sonnet multi-turn + thinking) + preflight (Haiku) + holístico + banco de anti-patrones + guardia de 5 categorías. **El chat externo no tiene UI consumidora.** |
| **Contratos / presets / brands** | Estable | `scene.schema` por delante del pipeline (soporta lo que el pipeline no emite). 1 preset learned aprobado arrastra un blob base64 de 113KB. |
| **App / UI / endpoints / admin** | Funcional core | Auto-recovery de runs zombie. Huérfanos: `/live` (sin link en nav), chat-validador sin UI, `auto-fix` sin sección en /admin (solo botón flotante). |
| **Infra / DB / config** | Estable | 6 migraciones coherentes. Sin auto-migrate. Costo de video Veo **subestimado** (placeholder $0.17 fijo). |
| **Human-in-the-loop / co-piloto** | Funcional, poco descubrible | Pausa colaborativa por escena + 3 niveles de owner-feedback + propagación cross-scene/cross-run. `/live` solo alcanzable vía `/build`. |
| **Scripts CLI (~116)** | Mezcla útiles + basura | ~52 `.cjs` efímeros con IDs hardcodeados. `heygen-medico.ts` contradice el invariante (voz nativa Veo). |

---

## 2. Hallazgos transversales (los que cambian el mapa mental)

1. **El círculo detectar→corregir YA está cerrado a nivel código** (pasos 1-7). El "brazo" regenera solo la escena que falla con OK del owner, reusando `applyCorrection`. Lo que falta: paso 8 (aprender de la reparación) y **Fase 3**.
2. **El norte real = Fase 3: que el PIPELINE EMITA composiciones complejas** (PiP, multivoz, anotaciones por word-sync). El motor las SOPORTA; hoy solo nacen del `rip-fidelity-aligner` y del editor manual. Confirmado con grep: `pipeline.ts` no tiene `composite/freeform/CompositeElement/speakerId/annotation/pip`.
3. **Grieta UGC:** la animación está gateada a 2 formatIds (`b-roll-animated`/`voiceover-animated`). Los presets `ugc-*` quedan **estáticos** (no entran a Higgsfield ni al validador por clip). Choca con la prioridad "personas = clip con movimiento". Fix = ampliar el gate (`isAnimatedFormat`) o decidir por `route-profiles.animation:'real'`.
4. **`auto-fix` puede auto-aplicar código** (`.ts`, confianza ≥85, con backup+typecheck+revert) → única excepción real a "nada se auto-aplica". OFF por defecto.
5. **Seguridad floja:** cookies con valor literal `valid` (no token firmado), comparación de contraseña no timing-safe, `/brands` y `/arquitecto` fuera del middleware.
6. **Voseo en prompts internos** del validador (`respetalos`, `volvés`) que el normalizador `toNeutralSpanish` no toca (solo cubre chat/guion/UI).
7. **Costo de video subestimado:** los clips Veo se contabilizan como "imagen higgsfield high" $0.17 fijo; no escala con duración ni provider real.

---

## 3. Lo que SÍ funciona y es la base sólida

- El **flujo b-roll animado (comic/Pixar, Kling)** produce videos coherentes (es la ruta más madura).
- La **infraestructura de validación + auto-reparación** está probada (18 tests + 1 run real reparado).
- El **motor de composición** (Remotion/FreeformComposite) está probado y soporta todo lo de "Estilo CapCut".
- El **validador/chat IA** por clip es robusto (la inversión del owner en percepción+detección está bien hecha).

---

## 4. Docs STALE (no confiar sin verificar contra el código)

- **`ARQUITECTURA.md`** (2026-05-23): dice que la cascada multi-provider sigue sin arreglar (falso, ya está) y NO menciona círculo/compuerta/brazo. ~2 semanas atrasado.
- **`docs/manual-activaciones.md`**: presenta la compuerta como opt-in (`VF_GATE_ON_RENDER`) y "solo CLI / sin UI" — falso: es obligatoria y tiene UI (`GateFindings`).
- **`DOCUMENTO_MAESTRO.md`**: spec v1, obsoleto (pero `docs/README.md` aún lo llama "fuente de verdad").
- **`investigacion/99-PLAN-FINAL.md`**: redactado como pendiente; los pasos 1-2 ya se ejecutaron.
- **`HANDOFF.md` V9**: aún instruye activar `VF_GATE_ON_RENDER` (eliminado en V11).
- (Ya corregidos esta sesión: el invariante `circulo-leer-actuar` y el comentario del `RepairLoop` en `quality-gate.ts`.)

---

## 5. El norte pendiente (qué falta de verdad)

1. **Fase 3 — auto-emit de composición:** que el pipeline EMITA PiP/multivoz/anotaciones por word-sync (hoy se arma a mano en protos).
2. **Fase 4 — aprender:** persistir el resultado de cada reparación en la KB y reforzar prompts con patrones confirmados (paso 8 del círculo).
3. **Grieta UGC:** decidir si el UGC se anima por el pipeline (ampliar el gate).
4. (Menores) cerrar huecos de seguridad, conectar el chat-validador a UI, exponer auto-fix en /admin, parametrizar el costo real de video.
