# HANDOFF-USUARIO.md — Video Factory

> **Documento vivo.** Rige el onboarding, la distribución local-first, los
> prerrequisitos, las API keys y el buzón de sincronización del Cerebro.
> Actualizado: 2026-06-01.

---

## 0. Propósito y disciplina de mantenimiento

Este documento es el **contrato vivo entre el código y el empleado que lo
instala**. No es documentación técnica para desarrolladores (eso vive en
`ARQUITECTURA.md`); es la guía de primera mano para quien pone la herramienta
a correr y la usa día a día.

### A quién va dirigido

Empleados de la empresa bajo contrato, incluyendo perfiles no técnicos.
No está pensado para usuarios externos.

### Regla de actualización

Cada vez que se agrega, modifica o elimina una key, un prerrequisito, o cambia
el estado de algo marcado como "pendiente", **este archivo debe actualizarse en
el mismo commit que el cambio de código**. Sin esa actualización, el cambio no
está completo.

### Cross-links

- `HANDOFF.md` (raíz) — estado de sesión para IA/dev. Referencia este documento.
- `CLAUDE.md` (raíz) — guía para la IA. Referencia este documento en la sección
  de continuidad.
- `ARQUITECTURA.md` (raíz) — fuente de verdad del sistema para desarrolladores.

### Diferencia clave

| Documento | Para quién | Qué contiene |
|---|---|---|
| **HANDOFF-USUARIO.md** (este) | Empleado-usuario | Onboarding, keys, prereqs, sync |
| `ARQUITECTURA.md` | Dev / IA | Módulos, bloques, flujos internos, decisiones de arquitectura |
| `HANDOFF.md` | Dev / IA | Estado WIP, bugs activos, próximos pasos de desarrollo |

---

## 1. Modelo de distribución: LOCAL-FIRST

### Qué significa

Cada empleado instala el repositorio en **su propia máquina**. La app corre en
su proceso, los videos se generan en su disco, y la base de datos es un archivo
SQLite local (`db/local.db`). No hay servidor central ni almacenamiento en la
nube para los archivos de trabajo.

### Por qué este modelo

- **Esquiva el problema de storage:** los videos pesan 50–200 MB por run. Sin
  servidor central, no hay costo de almacenamiento ni de transferencia de datos.
- **Esquiva los jobs largos en web:** un render demora entre 60 y 120 segundos.
  Correr eso en el proceso local elimina los timeouts de servidor y las colas en
  la nube.
- **Esquiva la complejidad de privacidad:** los videos, scripts y eventos del
  Cerebro viven en el equipo del empleado, bajo las mismas condiciones de
  confidencialidad del contrato de trabajo.

### Limitaciones conocidas

- **Cada instalación es independiente:** los runs y los videos de un empleado no
  se comparten automáticamente con otros.
- **El Cerebro/KB queda aislado en cada disco**, a menos que se active el buzón
  de sincronización (ver sección 5).
- **Las actualizaciones de código son manuales:** cada empleado hace `git pull` y
  `pnpm install` después de que el equipo avisa que hay una versión nueva.

### Requisito de hardware mínimo

- RAM: 8 GB mínimo (16 GB recomendado para cómodo).
- CPU: 4 núcleos o más acelera el render de forma notable.
- Sistema operativo: Windows 10/11, macOS o Linux (x64 o arm64).

---

## 2. Prerrequisitos del sistema

### 2.1 Software requerido

| Herramienta | Versión mínima | Cómo verificar | Dónde obtener |
|---|---|---|---|
| Node.js | >= 20 (recomendado: v24 LTS) | `node --version` | https://nodejs.org |
| pnpm | >= 9 (fijado: pnpm@9.15.0) | `pnpm --version` | `npm install -g pnpm@9.15.0` |
| git | cualquier versión reciente | `git --version` | https://git-scm.com |

**Nota sobre pnpm:** si ya tienes una versión distinta de pnpm, instala
exactamente la 9.15.0 para evitar problemas con los lockfiles del monorepo:
```
npm install -g pnpm@9.15.0
```

### 2.2 ffmpeg

**No necesitas instalarlo globalmente.** Remotion incluye el binario bundled
para Windows (x64), Linux (x64 y arm64) y macOS (x64 y arm64).

Al correr `pnpm install`, el binario queda en:
```
node_modules/.pnpm/@remotion+compositor-{plataforma}@.../...
```

La app lo detecta automáticamente a través de `apps/web/lib/ffmpeg-locator.ts`.

Si por alguna razón el binario bundled no funciona (arquitectura no soportada o
instalación incompleta), el localizador cae al `ffmpeg` del PATH como fallback.
En ese caso excepcional, instala ffmpeg desde https://ffmpeg.org.

El endpoint de estado `/api/onboarding/status` verifica la presencia del binario
y lo reporta como booleano sin exponerte detalles de rutas internas.

### 2.3 Base de datos

La base de datos es un **archivo SQLite local**: `db/local.db` en la raíz del
monorepo. Se crea automáticamente al correr `pnpm db:migrate` (ver sección 3,
paso 5).

- No necesitas instalar ningún servidor de base de datos.
- `DATABASE_URL` apunta por defecto a `file:./db/local.db`. Puedes sobrescribirla
  en `.env` si quieres guardar la DB en otra ubicación.
- Si el equipo anuncia migraciones nuevas después de un `git pull`, vuelve a
  correr `pnpm db:migrate` para aplicarlas.

---

## 3. Flujo de onboarding paso a paso

> Sigue los pasos en orden. No saltes pasos.

### Paso 1 — Clonar el repositorio

```bash
git clone <URL-interna> video-factory
cd video-factory
```

Reemplaza `<URL-interna>` con la URL que te dé el responsable técnico.

### Paso 2 — Instalar dependencias

```bash
pnpm install
```

Esto instala todo el monorepo (Turborepo gestiona los paquetes internos).
Demora 1–3 minutos la primera vez. Al finalizar, Remotion descarga el binario
de ffmpeg bundled para tu plataforma.

### Paso 3 — Crear el archivo de entorno

```powershell
# PowerShell (Windows):
Copy-Item .env.example .env

# bash (macOS / Linux):
cp .env.example .env
```

El archivo `.env` está en `.gitignore` y **nunca se versiona ni se comparte**.
Contiene tus keys personales y la contraseña de la app.

### Paso 4 — Completar las API keys en .env

Abre `.env` con cualquier editor de texto (VS Code, Notepad, etc.) y completa
los valores reales. Consulta la sección 4 para la lista completa con
instrucciones por key.

**Orden recomendado:**
1. `APP_PASSWORD` (define tu contraseña de acceso)
2. Las tres requeridas: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `GOOGLE_AI_API_KEY`
3. Las recomendadas: `ANTHROPIC_API_KEY`, `GCP_PROJECT_ID`,
   `GOOGLE_APPLICATION_CREDENTIALS`
4. Las opcionales según qué funcionalidades vayas a usar

### Paso 5 — Migrar la base de datos

```bash
pnpm db:migrate
```

Crea `db/local.db` y aplica todas las migraciones. Solo hay que correrlo **una
vez en la instalación inicial** (y de nuevo si el equipo indica que hay
migraciones nuevas después de un `git pull`).

### Paso 6 — Levantar la app

```bash
pnpm dev
```

Levanta Turborepo que a su vez corre `next dev` en `apps/web`. Espera hasta ver:
```
Ready on http://localhost:3000
```

Si quieres levantar solo la app web (útil para desarrolladores):
```bash
pnpm --filter '@video-factory/web' dev
```

### Paso 7 — Verificar el setup

Abre http://localhost:3000 e ingresa con el `APP_PASSWORD` que configuraste.

Para ver un checklist visual de qué keys están configuradas y cuáles faltan,
navega a:
```
http://localhost:3000/onboarding
```

O consulta el endpoint directamente (mientras el servidor esté corriendo):
```bash
curl http://localhost:3000/api/onboarding/status
```

### Resumen de comandos

```bash
git clone <URL> video-factory
cd video-factory
pnpm install
cp .env.example .env   # (después editar con tus keys)
pnpm db:migrate
pnpm dev
# Abre http://localhost:3000/onboarding para verificar el setup
```

---

## 4. Lista completa de API keys y variables de entorno

### 4.1 Variables de app (siempre requeridas)

#### APP_PASSWORD

- **Para qué:** contraseña de acceso a toda la UI. El middleware la verifica en
  todas las rutas protegidas.
- **Obligatoria:** sí. Sin esta variable el servidor lanza un error al intentar
  verificar el login.
- **Dónde obtenerla:** defínela tú mismo. No es una key de terceros; es una
  contraseña que tú eliges y que nadie más conoce.
- **Ejemplo:** `APP_PASSWORD=mipassword2026`

#### DATABASE_URL

- **Para qué:** ruta a la base de datos SQLite local.
- **Obligatoria:** tiene un valor por defecto funcional (`file:./db/local.db`).
  Solo cambia este valor si quieres guardar la DB en otra ubicación.
- **Ejemplo:** `DATABASE_URL=file:./db/local.db`

---

### 4.2 Keys de IA — requeridas para el pipeline principal

#### OPENAI_API_KEY

- **Para qué:** generador de imágenes principal del pipeline (modelo gpt-image-1),
  TTS de respaldo para la narración (tts-1), y transcripción automática para
  subtítulos con Whisper (subtitles-whisper).
- **Obligatoria:** sí. Sin esta key no hay generación de imágenes ni TTS de
  respaldo.
- **Costo estimado:** es el mayor componente de costo por run (aproximadamente
  USD 2–3, principalmente por gpt-image-1).
- **Dónde obtenerla:** https://platform.openai.com/api-keys
- **Formato esperado:** empieza con `sk-proj-`

#### ELEVENLABS_API_KEY

- **Para qué:** TTS principal (voz y narración de los videos). Se usa en todos
  los runs que tienen voz activada.
- **Obligatoria:** sí. Sin esta key no hay narración de voz.
- **Dónde obtenerla:** https://elevenlabs.io/app/settings/api-keys
- **Formato esperado:** empieza con `sk_`

#### GOOGLE_AI_API_KEY

- **Para qué:** Gemini Vision para detectar y revisar escenas, validar
  composiciones, planificar escenas y analizar anuncios; Imagen 4 como
  generador de imágenes alternativo; Speech-to-Text de respaldo para
  subtítulos automáticos.
- **Obligatoria:** sí. Sin esta key no hay visión Gemini ni generación de
  imágenes alternativa.
- **Dónde obtenerla:** https://aistudio.google.com/app/apikey (Google AI Studio,
  gratuito con límites diarios)
- **Nota:** AI Studio tiene cuotas diarias. Para uso intensivo, activa Vertex AI
  con `GCP_PROJECT_ID` (ver sección 4.3).

---

### 4.3 Keys de IA — recomendadas (mejoran capacidad o rendimiento)

#### ANTHROPIC_API_KEY

- **Para qué:** Claude como juez IA en múltiples puntos del pipeline:
  - **M2** — preview-judge por imagen (verifica cada imagen generada)
  - **M5** — post-render-judge (valida el video completo al terminar)
  - **M6** — loop iterativo del editor (corrige escenas en ciclos)
  - **M7-A** — video-understander (analiza videos de referencia)
  - **M7-B** — auto-learn-preset (aprende estilos nuevos)
  - **M8** — chat/discuss y el Copilot flotante
  - **M9** — unified-judge, burned-text-detector, subtitle-judge
  - Editor IA iterativo, suggest-feedback, translate-feedback
- **Obligatoria:** no. La app funciona sin juez IA; los endpoints de judge
  retornan error si falta. Muchas funcionalidades avanzadas quedan inactivas.
- **Nota importante:** la key se trata como **inactiva** si su valor empieza con
  `ROTATE_`. Ese prefijo es una señal de que la key está en proceso de rotación;
  los endpoints la ignoran en ese estado.
- **Recomendación:** activar si usas el Copilot, el editor IA o el Cerebro
  evolutivo. Es la key que habilita la capa más inteligente de la herramienta.
- **Dónde obtenerla:** https://console.anthropic.com/settings/keys
- **Formato esperado:** empieza con `sk-ant-api03-`

#### GOOGLE_SPEECH_API_KEY

- **Para qué:** Cloud Speech-to-Text dedicada para el bloque de subtítulos
  automáticos (`subtitles-google`). Si no está configurada, ese bloque usa
  `GOOGLE_AI_API_KEY` como fallback.
- **Obligatoria:** no. Funciona sin ella gracias al fallback.
- **Dónde obtenerla:** https://console.cloud.google.com/apis/credentials
  (misma cuenta que GCP)

#### GCP_PROJECT_ID

- **Para qué:** activa Vertex AI como ruta primaria para Gemini Vision e Imagen,
  sin los límites diarios de AI Studio. También habilita el proveedor de video
  Veo y Google Cloud Storage para almacenar rips.
- **Obligatoria:** no. Sin ella solo hay AI Studio (con límites). Se recomienda
  para uso intensivo.
- **Dónde obtenerla:** es el ID de tu proyecto en https://console.cloud.google.com
  (ejemplo: `mi-proyecto-123456`).
- **Nota:** requiere también `GOOGLE_APPLICATION_CREDENTIALS`.

#### GOOGLE_APPLICATION_CREDENTIALS

- **Para qué:** ruta al archivo JSON del service account de GCP con el rol
  "Vertex AI User". Necesario para autenticar llamadas a Vertex AI Imagen y Veo.
- **Obligatoria:** no. Solo necesaria junto con `GCP_PROJECT_ID`.
- **Dónde obtenerla:** https://console.cloud.google.com/iam-admin/serviceaccounts
  — crear service account, asignar rol "Vertex AI User", descargar el JSON de
  credenciales.
- **Ejemplo:** `GOOGLE_APPLICATION_CREDENTIALS=C:\Users\nombre\credenciales\sa.json`
- **Importante:** usa una ruta absoluta. En Windows, usa barras invertidas
  dobles (`\\`) o barras normales (`/`).

---

### 4.4 Keys de proveedores opcionales (amplían capacidades)

#### GCP_LOCATION

- **Para qué:** región de Vertex AI usada en los bloques de generación de
  imágenes, planificación de escenas, revisión de escenas, análisis de
  anuncios, validación de composición y generación de video (Veo).
- **Obligatoria:** no. El default implícito es `us-central1`.
- **Ejemplo:** `GCP_LOCATION=us-central1`

#### HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET

- **Para qué:** proveedor de respaldo para generación de imagen (flux-pro-kontext)
  y video image-to-video realista (modelo DoP — Director of Photography). Ideal
  para escenas con personas reales (UGC). Activa el proveedor
  `higgsfield:flux-pro-kontext`.
- **Obligatoria:** no. Es un proveedor de respaldo.
- **Dónde obtenerlas:** https://higgsfield.ai

#### KLING_ACCESS_KEY / KLING_SECRET_KEY

- **Para qué:** animación image-to-video con Kling v2-6 para B-ROLL animado
  (estilos Pixar, acuarela, comic). Activa el proveedor `kling:v2-6` en el
  animador de escenas.
- **Obligatoria:** no. Proveedor de animación opcional.
- **Dónde obtenerlas:** https://klingai.com

#### FAL_API_KEY

- **Para qué:** fal.ai como proveedor adicional de generación de imágenes
  (flux-pro). Activa el proveedor `fal:flux-pro`.
- **Obligatoria:** no. Proveedor adicional.
- **Dónde obtenerla:** https://fal.ai

#### ZAPCAP_API_KEY

- **Para qué:** subtítulos automáticos animados estilo CapCut vía la API de
  ZapCap. La app funciona sin subtítulos externos.
- **Obligatoria:** no.
- **Dónde obtenerla:** https://zapcap.ai
- **Nota:** el plan gratuito de ZapCap agrega marca de agua. El plan de pago
  ($10/mes) la elimina sin necesidad de cambiar código.

---

### 4.5 Variables de configuración opcionales

#### LOG_LEVEL

- **Para qué:** nivel de logging del logger interno (pino).
- **Valores:** `debug` | `info` | `warn` | `error`. Default: `info`.
- **Ejemplo:** `LOG_LEVEL=debug` para ver todo el detalle durante troubleshooting.

#### VF_STORAGE_DIR

- **Para qué:** directorio raíz de almacenamiento (videos generados, logs,
  Cerebro/KB, memoria del sistema).
- **Nota:** `next.config.mjs` lo inyecta automáticamente apuntando a
  `<raíz-del-repo>/storage`. No es necesario configurarlo a menos que quieras
  guardar el storage en otro disco o directorio.
- **Default automático:** `<raíz-del-repo>/storage`

#### PORT / APP_URL

- **Para qué:** puerto y URL base de la app. Declarados en `.env.example` para
  referencia.
- **Nota:** Next.js usa el puerto 3000 por defecto. Estos valores no son leídos
  directamente por el código de la app; son solo referencia.

---

### 4.6 Variables solo para desarrollo (no para uso normal)

Estas son flags de desarrollo internas. **No las uses en uso normal** — pueden
desactivar validaciones importantes o acelerar el pipeline a expensas de
calidad.

| Variable | Efecto |
|---|---|
| `DISABLE_REAL_ANIMATION=1` | Saltea la animación real de escenas (útil para tests rápidos sin gastar cuota) |
| `DISABLE_VALIDATOR_THINKING=1` | Desactiva el extended thinking de Claude en el validator-chat; validator más rápido pero menos preciso |
| `KEN_BURNS_ONLY=1` | El animador de escenas solo aplica Ken Burns (imagen fija con pan/zoom), no genera video real |
| `AUTO_FIX_PROCESS_ON_REPORT=1` | El endpoint de auto-fix procesa el error inmediatamente al recibirlo, sin espera manual |

---

## 5. Buzón central y sincronización OPT-IN del Cerebro

### 5.1 Qué es el Cerebro (KB)

El "Cerebro" es la Base de Conocimiento (KB) de cada instalación. Es un sistema
**append-only** de eventos estructurados que se registran automáticamente
durante el uso de la herramienta:

- Runs completados o fallidos (con métricas: costo, duración, cantidad de
  imágenes)
- Juicios de presets (aprobados, rechazados, editados)
- Feedback del operador escena por escena
- Chats con el Copilot
- Sugerencias enviadas al admin
- Hallazgos de auditorías automáticas

Los eventos se guardan en:
```
storage/kb/eventos/<subsistema>.jsonl
```
Un archivo JSONL por subsistema (pipeline, validator, chat, aprendizaje, etc.).
Cada evento es un objeto JSON con 14 campos: id, timestamp, versión del código,
tipo, entidad relacionada, severidad, título, contenido, tags, y más.

Este Cerebro **es la memoria del sistema**: permite que las futuras corridas
aprendan de las pasadas, que las auditorías encuentren patrones sistémicos, y
que el Copilot tenga contexto del trabajo anterior.

### 5.2 El problema: cada Cerebro queda aislado

En el modelo LOCAL-FIRST, cada instalación acumula su propio Cerebro. El
responsable del equipo no tiene visibilidad de los aprendizajes, errores o
patrones que emergen en los equipos de otros empleados, a menos que se
implemente un mecanismo de envío.

### 5.3 El buzón central: qué se envía y qué no

**Se envían:** eventos estructurados del KB (`KbEvento`). Son metadatos de
aprendizaje: qué preset funcionó, qué escena falló, qué feedback dio el
operador, métricas de runs. Son objetos JSON pequeños (menos de 1 KB cada uno).

**NO se envían (nunca):**
- Videos
- Imágenes generadas
- Audio
- Scripts completos
- Datos personales de clientes finales
- El valor de ninguna API key

Solo eventos estructurados de aprendizaje.

### 5.4 Comportamiento por defecto: OFF

La sincronización está **desactivada por defecto**. Si `VF_LEARNING_SYNC_URL`
no está configurada en `.env`, el módulo de sync es un no-op total: no hace
ninguna llamada de red, no lee archivos adicionales, no tiene costo ni impacto
en el rendimiento.

### 5.5 Cómo activar la sincronización

Para activar la sync, el responsable técnico debe proveer dos variables que
agregas a tu `.env`:

```bash
# URL del endpoint central de aprendizaje (te la provee el responsable técnico)
VF_LEARNING_SYNC_URL=https://<endpoint-central>/api/sync-eventos

# Bearer token de autenticación para tu instalación (único por empleado)
VF_LEARNING_SYNC_KEY=<token-que-te-da-el-responsable>
```

### 5.6 Cómo funciona la sync (cuando está activada)

1. El módulo `apps/web/lib/kb/sync.ts` lee un cursor local en
   `storage/kb/sync-cursor.json` que registra el timestamp ISO 8601 del último
   evento enviado.
2. Llama al sistema de consulta del KB para obtener solo los eventos nuevos
   (incrementales, solo los posteriores al cursor).
3. Envía los eventos en lotes de hasta 500 al endpoint central via HTTP POST
   con el token de autenticación.
4. Si el envío es exitoso (respuesta 2xx), actualiza el cursor. Si falla, no
   actualiza el cursor; los eventos se reintentarán en la próxima sync.
5. Toda la operación es **best-effort**: si algo sale mal, el error se registra
   internamente pero **nunca interrumpe** el pipeline principal de generación
   de videos.

### 5.7 Estado actual del receptor central

El receptor central (el endpoint del servidor que recibe los eventos) **todavía
no está construido**. Es parte de los próximos pasos (ver sección 7.3).

El cliente de sync (`sync.ts`) ya está diseñado y listo para conectarse a ese
endpoint cuando exista. Mientras no exista, aunque configures
`VF_LEARNING_SYNC_URL`, el POST fallará silenciosamente y los eventos quedarán
en cola local hasta que el receptor esté disponible.

### 5.8 Privacidad y contexto laboral

Los empleados que usan esta herramienta lo hacen bajo contrato con la empresa.
El envío de eventos de aprendizaje al responsable técnico está dentro del
alcance del uso legítimo de herramientas internas de trabajo. Los eventos no
contienen datos personales de clientes finales ni información sensible; son
métricas y metadatos de producción de contenido interno.

---

## 6. Seguridad del endpoint de estado

El endpoint `/api/onboarding/status` (y el endpoint de diagnóstico
`/api/debug/env-check`) siguen la misma regla de seguridad:

- Retornan **solo presencia booleana** por key dentro de `keys` (`true` = configurada,
  `false` = falta) — por ejemplo `{ "keys": { "OPENAI_API_KEY": true } }`.
- **Nunca retornan el valor** de ninguna variable de entorno, ni siquiera el
  primer carácter ni la longitud.
- Si alguien intercepta la respuesta de `/api/onboarding/status`, solo sabe
  qué keys están configuradas (presentes), no cuáles son sus valores.

### Diferencia de acceso entre endpoints

| Endpoint | Acceso | Para qué |
|---|---|---|
| `/api/onboarding/status` | **Público** (no requiere login) | Checklist de setup pre-auth |
| `/api/debug/env-check` | **Requiere auth** (cookie de login) | Diagnóstico detallado para admins |
| `/onboarding` (página) | **Pública** (no requiere login) | Checklist visual de onboarding |

El endpoint `/api/onboarding/status` es público por diseño: el empleado
necesita verificar su setup **antes** de tener la cookie de login. Como no
expone valores de keys, no hay riesgo de exposición de credenciales.

---

## 7. Estado actual — qué está hecho vs. pendiente

### 7.1 Completado (disponible en el repo)

- [x] Pipeline completo de generación de videos verticales 9:16 (Crear / Ripear / Aprender)
- [x] Base de datos local SQLite con todas las tablas (runs, rips, training_videos)
- [x] Autenticación via APP_PASSWORD + cookie de sesión
- [x] Todos los bloques del pipeline: TTS, scene-planner, compositor, image-gen
  (múltiples proveedores), animación, subtítulos
- [x] Cerebro/KB — Fase 0: recolección automática de eventos
  (`record.ts`, 6 emisores cableados: chat, run-eventos, juicio-preset,
  sugerencias, feedback, hallazgos)
- [x] Cerebro/KB — Fase 1: consulta, stats y contexto para agentes
  (`query.ts`: `query`, `kbStats`, `buildContextFor`)
- [x] Cerebro/KB — Fase 2: auditoría profunda on-demand (`deep-audit.ts`)
- [x] Copilot flotante con historial por usuario (`CopilotWidget`)
- [x] Editor IA iterativo (M6) y post-render judge (M5)
- [x] Auto-mejora de prompts / Cerebro evolutivo (M7 #5)
- [x] Modo colaborativo (aprobación escena por escena)
- [x] Micro-escenas seleccionables + preview de plan
- [x] Opciones a la carta en crear (voz / subtítulos / animación / Ken Burns)
- [x] `.env.example` con la mayoría de keys documentadas
- [x] `ffmpeg-locator.ts` — detección automática del binario bundled de Remotion
- [x] `isFfmpegBundled()` — verificación de presencia del binario sin path externo

### 7.2 Esta tanda (doc + cimientos de código)

- [x] `HANDOFF-USUARIO.md` (este documento) — guía completa para el empleado
- [x] `apps/web/lib/kb/sync.ts` — cliente OPT-IN de sync al buzón central
  (no-op sin URL, best-effort, nunca lanza)
- [x] `apps/web/app/api/onboarding/status/route.ts` — endpoint público de
  checklist (solo presencia booleana, nunca valores)
- [x] `apps/web/app/onboarding/page.tsx` — checklist visual pre-auth
- [x] `apps/web/app/onboarding/layout.tsx` — layout mínimo sin sidebar
- [x] `.env.example` — actualizado con `GCP_LOCATION`, `FAL_API_KEY`,
  `VF_LEARNING_SYNC_URL`, `VF_LEARNING_SYNC_KEY`; `ZAPCAP_WEBHOOK_SECRET`
  marcada como sin uso activo; `ANTHROPIC_API_KEY` con comentario más completo
- [x] Cross-links desde `HANDOFF.md` y `CLAUDE.md` hacia este documento

### 7.3 Pendiente (próximas tandas)

- [ ] Receptor central de eventos (endpoint del servidor que recibe el POST de
  `sync.ts`)
- [ ] Wizard de onboarding guiado que escriba las keys en `.env` de forma
  interactiva (interfaz paso a paso para empleados no técnicos)
- [ ] Trigger automático de sync (cron o hook post-run)
- [ ] Dashboard del responsable para visualizar eventos del Cerebro de múltiples
  instalaciones
- [ ] Corrección del bug de middleware en `/brands` (ruta pública por error,
  bug pre-existente fuera del scope actual)

---

## 8. Próximos pasos inmediatos

1. **Construir el receptor central** — el endpoint que recibe el POST de
   `sync.ts`. Sin él, la sync queda en standby (best-effort, reintentos locales).
2. **Conectar el trigger de sync** — agregar un hook post-run o un cron job que
   llame a `syncPendingEventos()` después de cada generación, o en intervalos
   regulares.
3. **Wizard de keys** — crear una interfaz paso a paso en `/onboarding` que
   guíe al empleado para configurar las keys sin editar archivos de texto
   manualmente.
4. **Actualizar este documento** cada vez que se agregue una key nueva al código
   o cambie el estado de un ítem en la sección 7.

---

## 9. Comandos de referencia rápida

```bash
# Instalar todas las dependencias del monorepo
pnpm install

# Migrar la DB (solo primera vez o después de git pull con migraciones nuevas)
pnpm db:migrate

# Levantar en modo dev
pnpm dev                                           # desde la raíz (Turborepo)
pnpm --filter '@video-factory/web' dev             # solo la app web

# Verificar el setup (mientras el servidor corre)
curl http://localhost:3000/api/onboarding/status   # checklist de keys (público)
curl http://localhost:3000/api/debug/env-check     # diagnóstico detallado (requiere login)

# Typecheck completo del monorepo
pnpm -r typecheck

# Tests de un paquete específico
pnpm --filter '<nombre-del-paquete>' test

# Regenerar tipos de DB (solo si editas db/schema.ts)
pnpm db:generate

# Abrir el checklist visual de onboarding en el navegador
# http://localhost:3000/onboarding
```

---

*Este documento se mantiene actualizado junto con el código. Si encuentras
información desactualizada, actualiza el archivo en el mismo PR/commit que
el cambio de código.*
