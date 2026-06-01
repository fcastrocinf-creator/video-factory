# Video Factory

Herramienta interna para generar videos verticales 9:16 (ads TikTok/Reels) para
marcas D2C (Vitaly, Nelo). Funcionalidad "Ripear": adapta el anuncio de otra
marca al producto propio.

Monorepo TypeScript: Next.js 14 · Remotion 4.x · Drizzle ORM + libsql · pnpm.

## Continuidad entre sesiones

**Si retomas trabajo o sos un Claude entrando fresco:**

1. Lee primero **`ARQUITECTURA.md`** — visión completa del sistema (3 modos
   operativos: Crear/Ripear/Aprender, bloques, validator, providers, taxonomía
   de perfiles, plan de evolución). Es el doc maestro vivo.
2. Después **`HANDOFF.md`** — estado de la sesión más reciente (qué está WIP,
   bugs en curso, próximos pasos inmediatos). Se actualiza al final de cada
   sesión grande.
3. Si vas a tocar la cascada de providers o la generación de imágenes,
   **`investigacion/99-PLAN-FINAL.md`** tiene el plan de fix detallado.
4. **`HANDOFF-USUARIO.md`** — si vas a cambiar keys, prereqs, el wizard de
   onboarding o el módulo de sync KB, mantén este documento actualizado en el
   mismo commit.

## Reglas

- **Idioma:** español neutro — formas con "tú", sin argentinismos.
- Tras editar archivos `apps/web/lib/*.ts`, reinicia `pnpm dev` si el cambio no se
  refleja: Next.js cachea los módulos del lado server.
- No commitear ni correr operaciones destructivas sin que el usuario lo pida.
- **ANTHROPIC_API_KEY** debe estar en `.env` raíz. `next.config.mjs` la sobreescribe
  siempre en `process.env` al arrancar el server (override por design — el .env raíz
  es fuente única de verdad). Verificar con `curl http://localhost:3000/api/debug/env-check`.

## Cerebro evolutivo (M7 #1/#3/#5, 25-may-2026)

- **#1 Burned-in text detector** — `packages/blocks/post-render-judge/src/burned-text-detector.ts`. Detecta texto glitchy/gibberish/wrong-language en visuales con Claude Vision. Integrado en M5 visual sample → si severity≥medium, M6 emite regenerate-scene automático con prompt reforzado
- **#3 Feedback loop de aprobación humana** — `packages/core/src/preset-judgment-memory.ts`. `recordPresetJudgment()` registra `approved`/`rejected`/`edited`/`run-success`/`run-failed`/`used-for-rip` en `storage/preset-memory/judgments.jsonl`. `getPresetConfidenceScores()` calcula ranking. Wired en: approve endpoint, pipeline run-completed, pipeline run-failed. Inyectado en `buildSystemContext` → cada llamada Claude ve preset confidence histórica
- **#5 Auto-mejora de prompts** — `apps/web/lib/prompt-evolution.ts`. `detectSystemicPatterns()` escanea logs + post-render-reports buscando errores que se repiten en N+ runs distintos. `proposePromptPatch()` le pide a Claude Sonnet un patch al SYSTEM_PROMPT del bloque afectado. `applyPatch(id)` lo escribe al source si owner aprueba. UI en `/admin` sección "🧬 Cerebro evolutivo". Endpoint: `POST /api/admin/prompt-patches` (detect) + `POST /api/admin/prompt-patches/[id]/decide` (approve/reject). El cerebro NO modifica código sin consentimiento — solo propone

## Capa de IA conversacional (M2/M3/M5/M6/M7/M8/M9)

Video Factory tiene Claude integrado como **capa universal de validación + asistencia**:

- **M2** — Claude Haiku judge per-imagen dentro de `image-gen-multi` (post SceneValidatorV3 anatomy check)
- **M3** — UI log de validaciones IA en `/runs/[id]` (`<ValidationLog>` + `GET /api/runs/[id]/validations`). Muestra el post-render-report.json (M5) y la editor-conversation.md (M6) directamente en el viewer del run
- **M5** — Post-render judge: valida coverage, duración, calidad visual sample, subtítulos. Persiste `post-render-report.json`
- **M6** — Loop iterativo conversacional del editor IA. Emite acciones ejecutables (`extend-duration`, `trim-duration`, `regenerate-scene`, `adjust-prompt`, `approve`, `manual-fix`). Max 3 iteraciones. Persiste `editor-conversation.md`
- **M7 Pieza A** — `video-understander.ts` — Claude multimodal mira keyframes y devuelve análisis estructurado (style, hook, palette, character, scenes, suggestedPreset)
- **M7 Pieza B v1** — `auto-learn-preset.ts` — entiende video y construye `PresetConfig` completo persistido en `packages/presets/pending/learned-auto-*.preset.json`
- **M7 Pieza C v2** — `packages/core/src/claude-judge.ts` (primitivos) + `apps/web/lib/unified-judge.ts` (capa con auto-inyección de system-context). Los juezes M2 (preview-judge.ts), M5 subtitle-judge / editor-verdict y M6 (editor-loop) ya están MIGRADOS al primitivo unificado. Cualquier nuevo flujo IA en apps/web debe usar `unifiedJudge<TSchema>(...)`; nuevos juezes en `packages/blocks/*` deben usar `judgeWithClaude<TSchema>(...)` de `@video-factory/core`. `preview-judge/claude-client.ts` queda como compat legacy
- **M8** — `<ClaudeChatPanel>` componente reusable. Plugeado en `/sugerencias`, `/create`, `/rip/[id]`, `/runs/[id]/editor` con `contextType` específico. Backend en `lib/claude-chat-discuss.ts` + endpoint `POST /api/chat/discuss`
- **M9** — `system-context.ts` (snapshot del proyecto) + `system-log.ts` (auto-log de eventos a `storage/system-log.jsonl`). Toda llamada a Claude inyecta el contexto para que SIEMPRE razone con el estado actual del proyecto

**Modelo default:** `claude-haiku-4-5` (rápido y barato). Escalable a `claude-sonnet-4-5` o `claude-sonnet-4-6` para casos críticos.

## Capa video providers (image-to-video)

Routing inteligente en `apps/web/lib/scene-animator.ts`:

- **Higgsfield DoP** (primary para UGC/realistas): endpoint `POST /v1/image2video/dop` con model `dop-turbo`. Mejor realismo facial humano. Flujo: upload imagen vía `/files/generate-upload-url` → submit con `{params: {model, prompt, input_images, duration}}` → poll `/requests/{id}/status`
- **Kling v2-6** (primary para B-ROLL animado): mejor para Pixar/acuarela/comic. Concurrency 5
- **Veo** (fallback): siempre disponible, más lento pero confiable

El preferHiggsfield se activa cuando `formatId.startsWith('ugc-')` o el styleId contiene "realista|fotorealista|real|ugc".

## Comandos

- Typecheck completo: `pnpm -r typecheck`
- Levantar la app: `pnpm --filter '@video-factory/web' dev` → `http://localhost:3000`
- Tests de un paquete: `pnpm --filter '<nombre>' test`

## Estructura

- `apps/web` — Next.js app: UI, API routes, y orquestación del pipeline en `lib/`
- `packages/blocks/*` — bloques del pipeline (tts, scene-planner, compositor, etc.)
- `packages/contracts` — schemas Zod compartidos
- `packages/core` — utilidades core (error-memory, composition-memory)
- `packages/presets` — presets de estilo; los aprendidos quedan en `pending/`
- `packages/brands` — definiciones de marca
- **`ARQUITECTURA.md`** — doc maestro del sistema (leer primero)
- `HANDOFF.md` — estado de traspaso entre sesiones
- `DOCUMENTO_MAESTRO.md` — spec original v1 (referencia histórica, no editar)
- `investigacion/` — research + planes de evolución; el más importante es `99-PLAN-FINAL.md`
