# Onboarding - Video Factory

Bienvenido/a al proyecto. Esta guía te lleva de cero a tener Video Factory
corriendo en tu máquina y entendiendo cómo está armado.

## ¿Qué es esto?

Video Factory es una herramienta interna para generar **videos verticales 9:16**
(ads tipo TikTok/Reels) con IA, para marcas D2C propias (Vitaly, Nelo).

Su función central es **"Ripear"**: toma el video de un anuncio existente y
genera uno nuevo, adaptado a un producto propio, replicando su estructura y
estilo.

Es un **monorepo TypeScript**: Next.js 14 · Remotion 4.x · Drizzle ORM + libsql · pnpm.

## Orden de lectura recomendado

1. **Este archivo** (`ONBOARDING.md`) — setup y panorama general.
2. **`DOCUMENTO_MAESTRO.md`** — la arquitectura completa; es la fuente de verdad.
3. **`HANDOFF.md`** — el estado actual: trabajo en curso, bugs conocidos y
   próximos pasos. Se actualiza al final de cada sesión grande.
4. **`README.md`** — referencia rápida de comandos y estructura.
5. **`CLAUDE.md`** — reglas para asistentes de IA (Claude Code).

## Requisitos previos

- **Node.js 20 o superior** (el proyecto corre con v24).
- **pnpm 9 o superior** (`npm install -g pnpm`).
- **git**.
- Una cuenta en cada proveedor de IA, para obtener las API keys (ver abajo).

No hace falta instalar ffmpeg aparte: Remotion incluye el suyo.

## Setup paso a paso

```powershell
# 1. Clonar el repositorio
git clone <URL-del-repo>
cd video-factory

# 2. Instalar dependencias (todo el monorepo)
pnpm install

# 3. Crear el archivo de entorno
Copy-Item .env.example .env
#    Editar .env y completar las API keys reales (ver sección siguiente)

# 4. Crear y migrar la base de datos local
pnpm db:migrate

# 5. Levantar la app
pnpm dev
```

Después, abrir <http://localhost:3000> e ingresar con el `APP_PASSWORD`
que pusiste en el `.env`.

## API keys - qué necesitas

El proyecto llama a varios servicios de IA de pago. Cada uno necesita su key en
el archivo `.env` (que **nunca se versiona**). El detalle de cada variable está
comentado en `.env.example`. Resumen:

| Servicio | Variable(s) | Para qué | ¿Requerida? |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | Generación de imágenes (gpt-image-1) | Sí |
| ElevenLabs | `ELEVENLABS_API_KEY` | Voz / narración (TTS) | Sí |
| Google AI | `GOOGLE_AI_API_KEY` | Visión Gemini + Imagen + Speech | Sí |
| Google Speech | `GOOGLE_SPEECH_API_KEY` | Subtítulos vía Speech-to-Text | Recomendada |
| Vertex AI | `GCP_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS` | Ruta primaria de Gemini/Imagen, sin límites diarios | Recomendada |
| Higgsfield | `HIGGSFIELD_KEY_ID` / `_SECRET` | Respaldo de imagen y video | Opcional |
| Kling | `KLING_ACCESS_KEY` / `_SECRET` | Animación image-to-video | Opcional |

> **Ojo:** estas keys cuestan dinero por uso. Un "rip" completo cuesta del orden
> de USD 2-3 (sobre todo por gpt-image-1). Nunca compartas tus keys ni las subas
> al repositorio.

## Cómo funciona - el pipeline

Generar un video "ripeado" pasa por una cadena de etapas. Cada etapa es un
**bloque** (en `packages/blocks/`), y la lógica que los encadena vive en
`apps/web/lib/` (sobre todo `pipeline.ts` y `rip-fidelity-aligner.ts`):

```
script-processor -> narrator-analyzer -> tts-elevenlabs -> subtitles-google ->
scene-planner -> rip-fidelity-aligner -> compositor-remotion -> final.mp4
```

En resumen: se procesa el guion, se genera la voz, se transcriben los
subtítulos, se planifican las escenas, se generan y alinean las imágenes, y
finalmente Remotion compone el video.

## Estructura del repositorio

| Carpeta | Qué contiene |
|---|---|
| `apps/web/` | App Next.js 14: UI, API routes y orquestación del pipeline (`lib/`) |
| `packages/core/` | Interfaces `Block` y `Pipeline`; utilidades core |
| `packages/contracts/` | Schemas Zod compartidos |
| `packages/blocks/*` | Los bloques del pipeline (tts, subtítulos, imágenes, compositor...) |
| `packages/brands/` | Configs JSON de las marcas |
| `packages/presets/` | Presets visuales (los aprendidos quedan en `pending/`) |
| `packages/ui/` | Componentes React compartidos |
| `db/` | Schema Drizzle y migrations |
| `storage/` | Artifacts generados por la app (no se versiona) |
| `docs/` | Documentación de referencia |

## Comandos útiles

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Levanta `apps/web` en modo desarrollo |
| `pnpm typecheck` | Type-check de todo el monorepo |
| `pnpm build` | Build de todos los paquetes |
| `pnpm test` | Corre los tests (Vitest) |
| `pnpm db:migrate` | Aplica las migrations a la DB local |
| `pnpm format` | Formatea el código con Prettier |

## Cosas que conviene saber

- **Next.js cachea los módulos del lado server.** Si editas archivos en
  `apps/web/lib/*.ts` y el cambio no se refleja, reinicia `pnpm dev`.
- **Idioma del proyecto:** español neutro (formas con "tú", sin argentinismos).
- El `HANDOFF.md` siempre tiene el estado más fresco — bugs abiertos, trabajo en
  curso y próximos pasos. Conviene leerlo antes de tocar código.
- No se commitea ni se corren operaciones destructivas sin pedirlo.

## ¿Dudas?

Para la arquitectura a fondo, lee `DOCUMENTO_MAESTRO.md`. Para saber en qué
estado está el proyecto hoy, `HANDOFF.md`.
