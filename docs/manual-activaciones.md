# Registro de ACTIVACIONES — Video Factory (base del manual de usuario)

Todo lo que **NO está encendido automáticamente** y que se puede olvidar activar. Es la fuente para el manual de usuario.

> **Mecánica base (CRÍTICA):** `apps/web/next.config.mjs` lee el `.env` de la **raíz** del monorepo y sobreescribe `process.env` al arrancar. → Toda variable nueva va al **`.env` raíz** (no a `apps/web/.env`), y hay que **reiniciar `pnpm dev`** para que tome cambios. Verificar con `curl http://localhost:3000/api/debug/env-check`.

---

## 1) Feature flags por variable de entorno (`.env` raíz)

### Knowledge Base / Consejo / Compuerta / Sync
| Variable | Activar con | Default | Qué hace |
|---|---|---|---|
| `VF_AUTO_AUDIT` | `=1` | **OFF** | Análisis continuo del Consejo (deepAudit) tras cada run. Solo observa/propone. También por botón en `/admin`. |
| `VF_AUTO_AUDIT_EVERY` | `=N` | 5 | Cada cuántos runs corre. |
| `VF_AUTO_AUDIT_MAX_HOURS` | `=N` | 24 | También corre si pasaron N horas. |
| `VF_GATE_FAIL_ON` | `high`/`critical` | `critical` | Severidad que vuelca la compuerta a "fail". |
| `VF_GATE_REVIEW_ON` | `medium`/`high` | `high` | Severidad que vuelca a "revisar". |
| `VF_GATE_REVIEW_ON_MEDIUM_COUNT` | `=N` | 3 | Nº de "medium" que disparan "revisar". *(no está en .env.example)* |
| `VF_GATE_COUNT_UNVERIFIED` | `0`/`1` | `true` | Si los hallazgos no verificados cuentan (fail-safe). *(no está en .env.example)* |
| `VF_GATE_USE_GEMINI` | `=1` | **OFF** | Enchufa el **juez Gemini video+audio** (lipsync/ritmo/audio) a la compuerta. Sin él solo mira keyframes. |
| `VF_GATE_ON_RENDER` | `=1` | **OFF** | Corre la **compuerta automáticamente** sobre el `final.mp4` al terminar cada run (best-effort, no bloquea; persiste el veredicto). Es el interruptor que vuelve **automática** la compuerta. |
| `VF_STORAGE_DIR` | (se fuerza en código) | `<root>/storage` | Carpeta única de storage. No tocar a mano. |
| `VF_LEARNING_SYNC_URL` | `=<URL>` | **OFF** | "Buzón central" opt-in: empuja eventos del KB a un receptor central. Vacío = no hace nada. |
| `VF_LEARNING_SYNC_KEY` | `=<token>` | vacío | Auth de la sync (si hay URL). |
| `VF_SYNC_INGEST_KEY` | `=<token>` | **OFF** | Solo en la instalación RECEPTORA: token que exige `/api/sync/ingest`. |

### Animación / Render (potentes y NO documentadas en `.env.example`)
| Variable | Activar con | Default | Qué hace |
|---|---|---|---|
| `DISABLE_REAL_ANIMATION` | `=1` | OFF | Apaga el animator (Kling/Veo/Higgsfield) → imágenes estáticas + Ken Burns. |
| `KEN_BURNS_ONLY` | `=1` | OFF | Corre el animator pero sin llamar a Kling/Veo (deja estático con Ken Burns). |
| `DISABLE_VALIDATOR_THINKING` | `=1` | OFF | Apaga el "extended thinking" del VALIDATOR CHAT IA (más rápido, menos profundo). |
| `AUTO_FIX_PROCESS_ON_REPORT` | `=1` | OFF | Procesa la cola de auto-fix de código al instante (ver ⚠️ abajo). |

*(Auxiliares: `LOG_LEVEL`, `PORT`, `APP_URL`, `GCP_LOCATION`, `GCS_BUCKET_NAME`, `VIDEO_FACTORY_ROOT`.)*

---

## 2) API keys / credenciales requeridas

| Key | Estado | Sin ella… |
|---|---|---|
| `APP_PASSWORD` | requerido | la app no deja entrar. |
| `ADMIN_PASSWORD` | seguridad | `/admin` cerrado. (Owner: `CLAVEADMIN123`.) |
| `DATABASE_URL` | requerido | sin DB no hay runs. (Default `file:./db/local.db`.) |
| `ANTHROPIC_API_KEY` | **interruptor maestro de la IA** | apaga TODO: validator, copilot, auditoría, judges, aprendizaje, auto-fix, **la compuerta**. Inactiva si empieza con `ROTATE_`. |
| `GOOGLE_AI_API_KEY` (+ `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`) | requerido | Gemini (visión, ad-analyzer, **juez video+audio**), Imagen, Veo. |
| `OPENAI_API_KEY` | requerido | generador de imagen primario + TTS de respaldo + whisper. |
| `ELEVENLABS_API_KEY` | requerido | TTS principal + word-sync al milisegundo. |
| `HIGGSFIELD_KEY_ID` + `HIGGSFIELD_KEY_SECRET` | opcional | UGC realista (DoP) + Flux. |
| `KLING_ACCESS_KEY` + `KLING_SECRET_KEY` | opcional | animación B-roll primaria. |
| `FAL_API_KEY` | opcional | imágenes flux adicionales. |
| `ZAPCAP_API_KEY` | opcional | subtítulos quemados estilo CapCut. |
| `HEYGEN_API_KEY` | opcional | cabezas que hablan (solo en pipeline de corrección manual). |
| `GOOGLE_SPEECH_API_KEY` | recomendada | STT dedicado (subtítulos auto están OFF, ver abajo). |

---

## 3) ⚠️ Capacidades que EXISTEN pero NO corren solas (no enganchadas)

| Capacidad | Hoy se dispara… | Falta para que sea automática |
|---|---|---|
| **Compuerta de calidad** (`runQualityGate`) | CLI `scripts/run-quality-gate.ts` **o automática** en el pipeline si `VF_GATE_ON_RENDER=1` (best-effort, post-render) | Falta exponer el veredicto en la **UI del run** (hoy se persiste + loggea). |
| **Panel format-audit** (`runFormatAudit`) | SOLO por CLI `scripts/run-format-audit.ts` | Engancharlo al flujo de rip/render. |
| **deepAudit (Consejo)** | botón `/admin` o `VF_AUTO_AUDIT=1` | encender el flag/botón. |
| **prompt-evolution applyPatch** | manual + aprobado en `/admin` | opt-in por diseño (no automatizar). |
| **Subtítulos automáticos** | **DESACTIVADO** en código (decisión owner) | descomentar ~3 líneas en `pipeline.ts` (~366-398). |

⚠️ **Excepción real a "nada se auto-aplica":** `apps/web/lib/auto-fix.ts` PUEDE escribir arreglos de **código `.ts`** sin aprobación si `confidence≥85` y se procesa la cola (`AUTO_FIX_PROCESS_ON_REPORT=1` o llamada manual). Está **OFF por defecto** y no toca `.env`/DB/migraciones, pero conviene revisarlo porque roza tu regla.

---

## 4) Opt-in por preset / overrides de UI (no por env)

`kenBurns` · `animatedScenes` (presets `b-roll-animated`/`voiceover-animated`) · `disableAnimation` · `skipVoice` · `preferHiggsfield` (auto si formato `ugc-*` o estilo realista) · `wordSync` (micro-escenas por palabra) · `identityAnchor` (personaje consistente) · `subtitlesZapcap` · `referenceVideoPath` (modo Ripear) · `mode: collaborative` (pausa por escena) · `useGemini`/`depth: profundo` en la compuerta.

---

## 5) Pasos manuales recurrentes
- **Reiniciar `pnpm dev`** tras editar `apps/web/lib/*.ts` o el `.env`.
- **`npx tsx scripts/sync-invariants.ts`** tras cambiar invariantes.
- **`npx tsx scripts/migrate.ts`** tras cambiar el schema de DB.
- **`pnpm -r typecheck`** antes de commitear.
- Aprobar patches de prompt en `/admin` → Cerebro evolutivo.

---

## Notas clave para el manual
1. Variables nuevas → **`.env` raíz** + reiniciar `pnpm dev`.
2. **`ANTHROPIC_API_KEY` es el interruptor maestro** de toda la inteligencia.
3. Flags potentes SIN documentar en `.env.example`: `DISABLE_REAL_ANIMATION`, `KEN_BURNS_ONLY`, `DISABLE_VALIDATOR_THINKING`, `AUTO_FIX_PROCESS_ON_REPORT`, `VF_GATE_REVIEW_ON_MEDIUM_COUNT`, `VF_GATE_COUNT_UNVERIFIED`, `GCS_BUCKET_NAME`.
4. La regla "nada se auto-aplica" tiene **una excepción** (`auto-fix.ts`, ver §3).
5. Las 2 capacidades de QA más fuertes (**compuerta** y **format-audit**) hoy **solo corren por CLI** — no están enganchadas al pipeline automático.
