# 🎬 VIDEO FACTORY MVP — DOCUMENTO MAESTRO COMPLETO

> **Documento único y completo del proyecto.** Esto reemplaza CLAUDE.md, README.md y todos los documentos auxiliares. Es la fuente de verdad. Léelo entero antes de empezar.

---

# ÍNDICE

1. [Visión general](#1-visión-general)
2. [Stack técnico](#2-stack-técnico-decidido)
3. [APIs externas — datos completos verificados](#3-apis-externas--datos-completos-verificados)
4. [Arquitectura: Sistema de Bloques](#4-arquitectura-sistema-de-bloques)
5. [Estructura del repositorio](#5-estructura-del-repositorio)
6. [Schemas Zod completos](#6-schemas-zod-completos)
7. [Flujo end-to-end del pipeline](#7-flujo-end-to-end-del-pipeline)
8. [Configuración inicial de marca y preset](#8-configuración-inicial-de-marca-y-preset)
9. [Variables de entorno](#9-variables-de-entorno)
10. [Roadmap acelerado](#10-roadmap-acelerado)
11. [Reglas inviolables](#11-reglas-inviolables)
12. [Cómo usar este documento con Claude Code](#12-cómo-usar-este-documento-con-claude-code)

---

# 1. VISIÓN GENERAL

## ¿Qué es Video Factory?

Una herramienta interna privada para generar **videos verticales 9:16** (TikTok/Reels) para múltiples marcas D2C propias, usando IA, con arquitectura modular de bloques intercambiables.

## Contexto del owner

- **Dueño de varias marcas D2C propias** (Vitaly, Nelo, más por venir)
- **Saca videos en volumen** para marketing performance
- **No tiene clientes externos**, todas las marcas son suyas
- **Quiere automatizar la producción** de videos que hoy hace su equipo a mano
- **Empieza con uso personal solo**, después abre a equipo

## Alcance del MVP (versión 1)

✅ Lo que SÍ va:
- Login simple con password local
- Una sola marca operativa al inicio (Vitaly), hardcodeada
- Un solo formato visual al inicio (Educativo · plano fijo)
- Pipeline end-to-end: guión → MP4 final
- Sistema de bloques (arquitectura) desde día 1

❌ Lo que NO va al inicio (se agrega después):
- Multi-marca con UI editable
- Editor visual de presets
- Cola de trabajos compleja
- Multi-escena con cortes rápidos
- Veo / Higgsfield (solo imagen estática primero)
- Integración con Growth Guide
- Generación de briefs editables

## Tipo de videos que vamos a generar

Basado en el análisis de 6 videos de referencia, hay **2 estrategias visuales principales**:

**Estrategia A — Plano fijo + voz narradora** (MVP inicial)
- 1 imagen estática IA estilo Pixar/Realista
- Voz narradora educativa autoritaria
- Subtítulos hook banner + captions inferiores
- Duración: 2-5 minutos
- Ejemplo: Doctor Pixar explicando reflujo

**Estrategia B — Multi-escena ilustrada** (fase posterior)
- 30-50 cortes por minuto
- Cada frase tiene su propia ilustración
- Estilos: acuarela médica, cartoon vintage, UGC simulado
- Duración: 30s a 3 minutos

---

# 2. STACK TÉCNICO DECIDIDO

| Capa | Tecnología | Versión | Razón |
|------|-----------|---------|-------|
| **Lenguaje** | TypeScript | 5.3+ | Un solo lenguaje, tipado estricto |
| **Runtime** | Node.js | 20.x LTS | Estable y soportado |
| **Frontend** | Next.js (App Router) | 14.x | UI + API en uno solo |
| **UI Components** | shadcn/ui + Tailwind | latest | Rápido de componer |
| **DB** | SQLite + Drizzle ORM | latest | Local, sin servidor extra |
| **Auth** | Password único en .env | — | MVP, un solo usuario |
| **Validación** | Zod | 3.22+ | Schemas compartidos entre bloques |
| **Render video** | Remotion | 4.x | Code-first, React-based |
| **Monorepo** | Turborepo + pnpm workspaces | latest | Estándar moderno |
| **Tests** | Vitest | latest | Solo donde es crítico |
| **Logs** | Pino | latest | Estructurados con runId |
| **Errores** | neverthrow | latest | `Result<T, E>` tipado |
| **HTTP client** | undici (Node native) | built-in | No agregar axios |

## Cómo se levanta

```bash
pnpm install
cp .env.example .env
# Editar .env con API keys
pnpm db:migrate
pnpm dev
```

Abrir <http://localhost:3000>.

---

# 3. APIs EXTERNAS — DATOS COMPLETOS VERIFICADOS

> ⚠️ Esta sección tiene los datos verificados al **mayo 2026**. Si pasa tiempo, verificar los endpoints actualizados.

## 3.1 ElevenLabs API (TTS)

**Web:** https://elevenlabs.io/docs
**Auth:** Header `xi-api-key: YOUR_API_KEY`

### Endpoint principal

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
```

### Request body
```json
{
  "text": "El texto a convertir en voz...",
  "model_id": "eleven_multilingual_v2",
  "voice_settings": {
    "stability": 0.40,
    "similarity_boost": 0.85,
    "style": 0.70,
    "use_speaker_boost": true
  }
}
```

### Modelos disponibles
- `eleven_multilingual_v2` → **mejor calidad** (recomendado para producción)
- `eleven_flash_v2_5` → **75ms latencia** (para tiempo real)
- `eleven_v3` → **última generación**, 70+ idiomas con tags expresivos

### Voces recomendadas (de los briefs reales del owner)
- **Valentina** (Latina Mature 40-48) → narradora femenina chilena
- **Adam** → narrador masculino
- **Charlotte** → narradora femenina farmacéutica

### Parámetros de voz (referencia real de Vitaly)
```
Stability: 0.40 (más expresivo) o 0.70 (más estable)
Similarity: 0.85
Style: 0.70 (expresivo) o 0.22 (neutral)
Speaker Boost: true
```

### Output
- Audio mp3 (default), también `pcm` o `ulaw`
- Calidad alta solo en planes pagos

### Pricing
- Plan Creator: $22/mes (~100k caracteres)
- ~$0.30 por 1000 caracteres = **~$0.30 por video de 2 minutos**

### Notación de pausas (importante)
El owner usa la convención `…` (tres puntos Unicode `U+2026`) para indicar pausas breves. El script debe respetarlas al construir el prompt para ElevenLabs.

---

## 3.2 OpenAI Whisper API (Subtítulos word-level)

**Web:** https://platform.openai.com/docs/guides/speech-to-text
**Auth:** Header `Authorization: Bearer YOUR_API_KEY`

### Endpoint
```
POST https://api.openai.com/v1/audio/transcriptions
```

### Request (multipart form data)
```javascript
const form = new FormData();
form.append('file', audioBlob, 'audio.mp3');
form.append('model', 'whisper-1');
form.append('response_format', 'verbose_json');
form.append('timestamp_granularities[]', 'word');
form.append('language', 'es');
```

### Response (word-level timestamps)
```json
{
  "task": "transcribe",
  "language": "spanish",
  "duration": 32.4,
  "text": "Si te queda el hoyito y no se llena al toque...",
  "words": [
    { "word": "Si", "start": 0.0, "end": 0.18 },
    { "word": "te", "start": 0.18, "end": 0.30 },
    { "word": "queda", "start": 0.30, "end": 0.62 },
    ...
  ],
  "segments": [...]
}
```

### Modelo
- `whisper-1` (oficial, soporta word-level timestamps) ⭐ **usar este**
- `gpt-4o-transcribe` y `gpt-4o-mini-transcribe` NO soportan word-level (todavía)

### Limitaciones
- Tamaño máximo: 25 MB por archivo
- Formatos: mp3, mp4, mpeg, mpga, m4a, wav, webm

### Pricing
- $0.006 por minuto de audio = **~$0.003 por video de 2 minutos** (despreciable)

---

## 3.3 Google Imagen 4 API (Generación de imagen estática)

**Web:** https://ai.google.dev/gemini-api/docs/imagen
**Auth:** API key de Google AI Studio o Service Account de Vertex AI

### Opción 1 — Gemini API (más simple, recomendado para MVP)

```
POST https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict
```

#### Request body
```json
{
  "instances": [
    {
      "prompt": "3D Pixar style asian doctor character, white lab coat, friendly smile, Japanese clinic interior, soft natural lighting, cinematic depth of field, 9:16 vertical aspect ratio"
    }
  ],
  "parameters": {
    "sampleCount": 1,
    "aspectRatio": "9:16",
    "safetyFilterLevel": "block_some",
    "personGeneration": "allow_adult"
  }
}
```

### Opción 2 — Vertex AI SDK (para producción)

```typescript
import { VertexAI } from '@google-cloud/vertexai';

const vertex = new VertexAI({ project: 'mi-project', location: 'us-central1' });
const model = vertex.getGenerativeModel({ model: 'imagen-4.0-generate-001' });
// ... usar SDK
```

### Modelos disponibles
- `imagen-4.0-generate-001` → **última versión, recomendado** ⭐
- `imagen-3.0-generate-002` → estable, sigue funcionando

### Pricing
- ~$0.04 por imagen 1024×1024
- ~$0.05 por imagen vertical 1080×1920
- **Costo total imagen para 1 video: ~$0.05**

### Limitaciones importantes
- **Aspect ratio:** `1:1`, `9:16`, `16:9`, `3:4`, `4:3`
- **Personas:** `allow_adult` por defecto, `dont_allow` para evitar generación de personas
- **Safety filter:** `block_some` es el default
- **Watermark SynthID:** se incluye automáticamente (no se puede quitar)

### SDK oficial recomendado
```bash
pnpm add @google/generative-ai
```

---

## 3.4 Google Veo 3.1 API (Generación de video) — Para Fase 2

**Web:** https://ai.google.dev/gemini-api/docs/video
**Auth:** Misma API key de Gemini o Service Account de Vertex AI

### Modelos disponibles (Veo 3.1, mayo 2026)

| Modelo | ID | Costo/segundo | Calidad | Audio nativo |
|---|---|---|---|---|
| **Veo 3.1 Lite** ⭐ | `veo-3.1-lite-generate-preview` | **$0.05/seg** | 720p | No |
| Veo 3.1 Fast | `veo-3.1-fast-generate-001` | $0.15/seg | 1080p / 4K | Sí |
| Veo 3.1 Standard | `veo-3.1-generate-001` | $0.40/seg | 1080p / 4K | Sí |

### Endpoint
```
POST https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning
```

### Request body
```json
{
  "instances": [
    {
      "prompt": "Close-up of asian doctor with friendly expression in Japanese clinic, soft natural lighting, slow subtle camera movement, photorealistic, cinematic"
    }
  ],
  "parameters": {
    "aspectRatio": "9:16",
    "durationSeconds": 8,
    "negativePrompt": "cartoon, animated, 3D render, low quality",
    "personGeneration": "allow_adult"
  }
}
```

### Pattern de uso (long-running operation)
```typescript
// Veo es asíncrono - se inicia operación, después se polling
const operation = await startVeoGeneration(prompt);  // returns operation ID
let status = "PENDING";
while (status === "PENDING") {
  await sleep(5000);
  status = await checkOperationStatus(operation.id);
}
const videoUrl = await getOperationResult(operation.id);
```

### Limitaciones importantes
- **Duración máxima por clip:** 8 segundos
- **Para videos más largos:** chain de hasta 20 clips con scene extension (140+ seg)
- **Tiempo de generación:** 1-3 minutos por clip
- **Aspect ratios:** `16:9`, `9:16`, `1:1`

### Pricing estimado para nuestro uso
- Video MVP estrategia A: **$0** (no usa Veo, solo imagen)
- Video estrategia B con Veo Lite: ~8 clips × 5 seg × $0.05 = **$2/video**
- Video estrategia B con Veo Fast: ~8 clips × 5 seg × $0.15 = **$6/video**

---

## 3.5 Higgsfield API (Opcional, Fase 3)

Higgsfield se usa para **image-to-video** con motion control fino. Usado por el owner en briefs reales.

- **Endpoint:** Variable según producto (Soul, Soul-2, Nano Banana 2)
- **Pricing:** Sistema de créditos
- **Uso típico:** Convertir una imagen estática (ej: producto) en video con movimiento sutil
- **Fase MVP:** NO se usa todavía. Se integra cuando se construya Estrategia B avanzada.

---

## 3.6 Remotion (Render local, sin API)

Remotion **no es una API externa** — es una librería de Node que ejecutamos localmente para renderizar el MP4 final.

### Instalación
```bash
pnpm add remotion @remotion/cli @remotion/bundler @remotion/renderer
```

### Lo que hace
- Compone audio + imagen + subtítulos en un MP4
- Permite efectos Ken Burns (zoom + pan progresivo)
- Subtítulos kinéticos word-by-word
- Output: MP4 1080×1920, 30fps, H.264

### Requisitos
- Chromium headless (se descarga automáticamente)
- ffmpeg (a veces incluido, a veces requiere instalar)

---

# 4. ARQUITECTURA: SISTEMA DE BLOQUES

## Filosofía

**Cada funcionalidad es un Bloque independiente** con interfaz estandarizada. Los bloques NO se conocen entre sí. Se componen en un Pipeline.

## Contrato Block

```typescript
// packages/core/src/block.ts
import { Result } from 'neverthrow';
import { Logger } from 'pino';

export interface Block<TInput, TOutput> {
  readonly name: string;           // "tts-elevenlabs"
  readonly version: string;        // "1.0.0"
  readonly description: string;
  
  // Validación de input
  validateInput(input: unknown): Result<TInput, Error>;
  
  // Ejecución principal
  run(input: TInput, ctx: BlockContext): Promise<Result<TOutput, BlockError>>;
}

export interface BlockContext {
  runId: string;                   // UUID del job
  workDir: string;                 // ./storage/runs/{runId}/
  logger: Logger;
  brand?: BrandConfig;             // Marca activa
  preset?: PresetConfig;           // Preset activo
}

export class BlockError extends Error {
  constructor(
    public readonly blockName: string,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
  }
}
```

## Reglas de los bloques

1. **Vivir en `packages/blocks/{nombre}/`**
2. **Validar input y output con Zod**
3. **NO depender de otros bloques** (solo de `core` y `contracts`)
4. **Guardar artifacts intermedios** en `ctx.workDir`
5. **Loggear con `ctx.logger`** incluyendo siempre `runId`
6. **Retornar errores tipados** con `Result<T, BlockError>`

## Pipeline

```typescript
// packages/core/src/pipeline.ts
export class Pipeline {
  private blocks: Block<any, any>[] = [];
  
  use<TIn, TOut>(block: Block<TIn, TOut>): this {
    this.blocks.push(block);
    return this;
  }
  
  async execute(initialInput: any, ctx: BlockContext): Promise<Result<any, BlockError>> {
    let current = initialInput;
    for (const block of this.blocks) {
      const result = await block.run(current, ctx);
      if (result.isErr()) return result;
      current = result.value;
    }
    return ok(current);
  }
}
```

---

# 5. ESTRUCTURA DEL REPOSITORIO

```
video-factory/
├── DOCUMENTO_MAESTRO.md           ← Este archivo, fuente de verdad
├── README.md                       ← Setup técnico breve
├── .env.example                    ← Variables modelo
├── .env                            ← gitignored, con keys reales
├── .gitignore
├── package.json                    ← Root del monorepo
├── tsconfig.json                   ← Config TypeScript base
├── pnpm-workspace.yaml             ← Workspace config
├── turbo.json                      ← Turborepo config
│
├── apps/
│   └── web/                        ← Next.js 14 — UI + API
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx            ← Login con password
│       │   ├── (app)/
│       │   │   ├── create/
│       │   │   │   └── page.tsx    ← Formulario principal
│       │   │   └── runs/
│       │   │       └── [id]/
│       │   │           └── page.tsx ← Preview y descarga
│       │   └── api/
│       │       ├── auth/
│       │       │   └── route.ts
│       │       └── generate/
│       │           └── route.ts    ← Dispara el pipeline
│       ├── components/
│       │   ├── ui/                 ← shadcn/ui generados
│       │   ├── BrandSelector.tsx
│       │   ├── PresetSelector.tsx
│       │   └── ScriptInput.tsx
│       ├── lib/
│       │   └── auth.ts
│       ├── public/
│       ├── tailwind.config.ts
│       ├── next.config.js
│       └── package.json
│
├── packages/
│   ├── core/                       ← Interfaces base
│   │   ├── src/
│   │   │   ├── block.ts            ← Interface Block
│   │   │   ├── pipeline.ts         ← Pipeline orchestrator
│   │   │   ├── context.ts          ← BlockContext
│   │   │   ├── errors.ts           ← BlockError
│   │   │   └── index.ts            ← Exports
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── contracts/                  ← Schemas Zod compartidos
│   │   ├── src/
│   │   │   ├── brand.schema.ts
│   │   │   ├── preset.schema.ts
│   │   │   ├── script.schema.ts
│   │   │   ├── scene.schema.ts
│   │   │   ├── audio.schema.ts
│   │   │   ├── subtitle.schema.ts
│   │   │   ├── render.schema.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── blocks/
│   │   ├── script-processor/       ← Limpia guión, detecta pausas (…)
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   └── block.ts
│   │   │   ├── test/
│   │   │   │   └── block.test.ts
│   │   │   └── package.json
│   │   │
│   │   ├── tts-elevenlabs/         ← Genera voz
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── block.ts
│   │   │   │   └── client.ts       ← Wrapper de ElevenLabs API
│   │   │   ├── test/
│   │   │   └── package.json
│   │   │
│   │   ├── subtitles-whisper/      ← Word-level timing
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── block.ts
│   │   │   │   └── client.ts       ← Wrapper de OpenAI Whisper
│   │   │   └── package.json
│   │   │
│   │   ├── image-gen-imagen/       ← Google Imagen 4
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── block.ts
│   │   │   │   └── client.ts       ← Wrapper de Imagen API
│   │   │   └── package.json
│   │   │
│   │   └── compositor-remotion/    ← Render final con Remotion
│   │       ├── src/
│   │       │   ├── index.ts
│   │       │   ├── block.ts
│   │       │   ├── compositions/
│   │       │   │   └── PlanoFijo.tsx ← Composición Remotion
│   │       │   └── render.ts
│   │       └── package.json
│   │
│   ├── presets/                    ← Base de conocimiento de estilos
│   │   ├── _schema.json            ← JSON Schema validador
│   │   ├── educativo_pixar.preset.json
│   │   └── README.md               ← Cómo agregar preset nuevo
│   │
│   ├── brands/                     ← Config de cada marca
│   │   ├── _schema.json
│   │   └── vitaly.brand.json
│   │
│   └── ui/                         ← Componentes React compartidos
│       └── src/
│
├── db/
│   ├── schema.ts                   ← Drizzle schema
│   └── migrations/
│
├── docs/                           ← Documentación de referencia
│   ├── analisis_videos_referencia.md
│   ├── analisis_videos_ugc.md
│   └── briefs_de_produccion/
│
├── storage/                        ← Gitignored
│   ├── runs/                       ← Outputs por generación
│   │   └── {runId}/
│   │       ├── audio.mp3
│   │       ├── subtitles.json
│   │       ├── image.png
│   │       ├── final.mp4
│   │       └── manifest.json
│   └── cache/                      ← Assets cacheados
│
└── scripts/
    ├── seed-brand.ts               ← Crea Vitaly inicial
    └── seed-preset.ts              ← Crea preset Pixar inicial
```

---

# 6. SCHEMAS ZOD COMPLETOS

## 6.1 BrandConfig

```typescript
// packages/contracts/src/brand.schema.ts
import { z } from 'zod';

export const ElevenLabsVoiceConfig = z.object({
  voiceId: z.string(),                    // ID de voz en ElevenLabs
  modelId: z.string().default("eleven_multilingual_v2"),
  stability: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speakerBoost: z.boolean().default(true),
  speedMultiplier: z.number().default(1.0),  // Velocidad post-procesado
});

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

export const BrandConfigSchema = z.object({
  id: z.string(),                         // "vitaly"
  displayName: z.string(),                // "Vitaly"
  
  products: z.array(ProductSchema),
  
  defaultVoice: ElevenLabsVoiceConfig,
  
  language: z.string(),                   // "es-CL", "es-MX"
  
  brandColors: z.array(z.string()).default([]),  // hex codes
  
  toneRules: z.object({
    avoid: z.array(z.string()).default([]),      // ["voseo argentino"]
    prefer: z.array(z.string()).default([]),
  }).default({ avoid: [], prefer: [] }),
  
  logoPath: z.string().optional(),
  
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BrandConfig = z.infer<typeof BrandConfigSchema>;
```

## 6.2 PresetConfig

```typescript
// packages/contracts/src/preset.schema.ts
import { z } from 'zod';

export const PresetConfigSchema = z.object({
  id: z.string(),                         // "educativo_pixar"
  displayName: z.string(),                // "Educativo · Doctor Pixar"
  description: z.string(),
  
  // Clasificación (dimensiones ortogonales)
  classification: z.object({
    formato: z.enum(["ugc", "educativo", "storytelling", "personaje_avatar"]),
    hookAngulo: z.enum(["objeciones", "curiosidad", "autoridad", "testimonio", "test_diagnostico"]),
    funnelStage: z.enum(["tofu", "mofu", "bofu"]),
    awareness: z.enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"]),
  }),
  
  // Estrategia de generación
  estrategia: z.enum(["plano_fijo", "multi_escena"]),
  
  // Engine visual
  visualEngine: z.enum(["imagen4", "veo-lite", "veo-fast", "veo-standard", "higgsfield"]),
  
  // Estilo visual
  visualStyle: z.object({
    promptTemplate: z.string(),           // "3D Pixar style {character}, {scene}"
    negativePrompt: z.string(),
    aspectRatio: z.literal("9:16"),
    referenceImages: z.array(z.string()).default([]),  // paths a imágenes de referencia
  }),
  
  // Subtítulos
  subtitles: z.object({
    style: z.enum(["hook_banner", "word_level_kinetic", "minimal_elegant"]),
    font: z.string().default("Inter"),
    fontSize: z.number().default(64),
    color: z.string().default("#FFFFFF"),
    strokeColor: z.string().default("#000000"),
    strokeWidth: z.number().default(4),
    highlightColor: z.string().default("#FFE600"),
    position: z.enum(["top", "center", "bottom"]),
    allCaps: z.boolean().default(true),
  }),
  
  // Voz override (opcional, si no usa default de la brand)
  voiceOverride: z.lazy(() => 
    z.object({
      voiceId: z.string(),
      stability: z.number(),
      similarity: z.number(),
      style: z.number(),
      speakerBoost: z.boolean(),
    }).optional()
  ),
  
  // Timing
  defaultDurationSeconds: z.number(),
  scenesPerMinute: z.number(),            // ~0.5 = plano fijo, ~30 = multi-escena
  
  // Compositor
  composition: z.object({
    kenBurns: z.object({
      enabled: z.boolean().default(true),
      zoomStart: z.number().default(1.0),
      zoomEnd: z.number().default(1.15),
      panX: z.number().default(0),
      panY: z.number().default(0),
    }),
    backgroundMusic: z.object({
      enabled: z.boolean().default(false),
      volumeDb: z.number().default(-20),
    }),
  }),
  
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PresetConfig = z.infer<typeof PresetConfigSchema>;
```

## 6.3 ScriptInput y ParsedScript

```typescript
// packages/contracts/src/script.schema.ts
import { z } from 'zod';

export const ScriptInputSchema = z.object({
  rawText: z.string().min(10),
  language: z.string().default("es"),
});

export const ParsedScriptSchema = z.object({
  language: z.string(),
  segments: z.array(z.object({
    text: z.string(),                     // Frase limpia
    pauseAfterMs: z.number().default(0),  // Pausa después de esta frase
    emphasisWords: z.array(z.string()).default([]),
  })),
  estimatedDurationSeconds: z.number(),
});

export type ScriptInput = z.infer<typeof ScriptInputSchema>;
export type ParsedScript = z.infer<typeof ParsedScriptSchema>;
```

## 6.4 AudioTrack

```typescript
// packages/contracts/src/audio.schema.ts
import { z } from 'zod';

export const AudioTrackSchema = z.object({
  filePath: z.string(),                   // Path al mp3 generado
  durationSeconds: z.number(),
  sampleRate: z.number().default(44100),
  channels: z.literal(1),                 // Mono
  format: z.literal("mp3"),
  
  // Timing por frase (mapeado al parsed script)
  segments: z.array(z.object({
    text: z.string(),
    startTimeSeconds: z.number(),
    endTimeSeconds: z.number(),
  })),
});

export type AudioTrack = z.infer<typeof AudioTrackSchema>;
```

## 6.5 SubtitleTrack

```typescript
// packages/contracts/src/subtitle.schema.ts
import { z } from 'zod';

export const SubtitleWordSchema = z.object({
  word: z.string(),
  startTimeSeconds: z.number(),
  endTimeSeconds: z.number(),
});

export const SubtitleTrackSchema = z.object({
  language: z.string(),
  words: z.array(SubtitleWordSchema),
  // Agrupación por líneas (calculada después)
  lines: z.array(z.object({
    text: z.string(),
    startTimeSeconds: z.number(),
    endTimeSeconds: z.number(),
    wordRefs: z.array(z.number()),       // Índices en words[]
  })),
});

export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;
```

## 6.6 RenderJob

```typescript
// packages/contracts/src/render.schema.ts
import { z } from 'zod';

export const RenderJobSchema = z.object({
  runId: z.string().uuid(),
  brandId: z.string(),
  presetId: z.string(),
  
  // Outputs de cada bloque previo
  parsedScript: ParsedScriptSchema,
  audioTrack: AudioTrackSchema,
  subtitleTrack: SubtitleTrackSchema,
  imagePath: z.string(),                  // Path a la imagen generada
  
  // Output esperado
  outputPath: z.string(),                 // Path al MP4 final
  resolution: z.tuple([z.literal(1080), z.literal(1920)]),
  fps: z.literal(30),
  
  // Status
  status: z.enum(["pending", "rendering", "completed", "failed"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional(),
});

export type RenderJob = z.infer<typeof RenderJobSchema>;
```

---

# 7. FLUJO END-TO-END DEL PIPELINE

## Input del usuario

```typescript
{
  brandId: "vitaly",
  presetId: "educativo_pixar",
  script: "Si no tienes hambre en la mañana, mi amigo, esto es reflujo. ..."
}
```

## Paso 1: script-processor

**Input:** `ScriptInput`
**Output:** `ParsedScript`

Lo que hace:
- Limpia espacios, normaliza puntuación
- Detecta `…` (U+2026) como marcas de pausa (300ms)
- Detecta `.` y `?` como pausas naturales (200ms)
- Divide en segmentos
- Estima duración total (palabras / 2.5 palabras-por-segundo)

```typescript
{
  language: "es",
  segments: [
    { text: "Si no tienes hambre en la mañana, mi amigo, esto es reflujo.", pauseAfterMs: 200 },
    { text: "Si despiertas a las tres de la mañana ahogándote, esto es reflujo.", pauseAfterMs: 200 },
    ...
  ],
  estimatedDurationSeconds: 32
}
```

## Paso 2: tts-elevenlabs

**Input:** `ParsedScript` + `BrandConfig.defaultVoice`
**Output:** `AudioTrack`

Lo que hace:
- Une los segmentos con `<break time="200ms"/>` (SSML-like de ElevenLabs)
- Llama a `POST /v1/text-to-speech/{voiceId}` con los `voice_settings` del brand
- Guarda mp3 en `workDir/audio.mp3`
- Calcula timing de cada segmento aproximando por duración total

```typescript
{
  filePath: "/storage/runs/abc-123/audio.mp3",
  durationSeconds: 32.4,
  segments: [
    { text: "Si no tienes hambre...", startTimeSeconds: 0, endTimeSeconds: 4.2 },
    ...
  ]
}
```

## Paso 3: subtitles-whisper

**Input:** `AudioTrack`
**Output:** `SubtitleTrack`

Lo que hace:
- Sube el `audio.mp3` a OpenAI Whisper
- Pide `verbose_json` con `timestamp_granularities=["word"]`
- Mapea las palabras a `SubtitleWord[]`
- Agrupa palabras en "líneas" de máximo 4-5 palabras cada una (para subtítulos legibles)

```typescript
{
  language: "es",
  words: [
    { word: "Si", startTimeSeconds: 0.0, endTimeSeconds: 0.18 },
    { word: "no", startTimeSeconds: 0.18, endTimeSeconds: 0.30 },
    ...
  ],
  lines: [
    { text: "Si no tienes hambre", startTimeSeconds: 0.0, endTimeSeconds: 1.2, wordRefs: [0,1,2,3] },
    { text: "en la mañana, mi amigo", startTimeSeconds: 1.2, endTimeSeconds: 2.5, wordRefs: [4,5,6,7,8] },
    ...
  ]
}
```

## Paso 4: image-gen-imagen

**Input:** `PresetConfig` + contexto de marca/script (para construir prompt)
**Output:** Path a `image.png` (1080×1920)

Lo que hace:
- Construye prompt a partir de `preset.visualStyle.promptTemplate`
- Llama a Google Imagen 4 API
- Guarda imagen en `workDir/image.png`

Para el preset `educativo_pixar`:
```
prompt: "3D Pixar style asian doctor character, white lab coat with stethoscope, 
         friendly smile, traditional Japanese clinic interior, soft natural lighting, 
         cinematic depth of field, warm color grading, photorealistic CGI"
aspectRatio: "9:16"
```

## Paso 5: compositor-remotion

**Input:** `RenderJob` (con todos los outputs anteriores)
**Output:** Path a `final.mp4`

Lo que hace:
- Carga la composición `PlanoFijo.tsx` de Remotion
- Pasa: imagen, audio, subtitles
- Aplica Ken Burns sutil (zoom 1.0 → 1.15 a lo largo del video)
- Renderiza subtítulos word-by-word con highlight de palabra activa
- Bundle + render con `@remotion/renderer`
- Output: MP4 1080×1920 30fps H.264

---

# 8. CONFIGURACIÓN INICIAL DE MARCA Y PRESET

## 8.1 brands/vitaly.brand.json

```json
{
  "id": "vitaly",
  "displayName": "Vitaly",
  "products": [
    {
      "id": "vitaly_gotas",
      "name": "Vitaly Gotas Drenaje Linfático",
      "description": "Suplemento líquido para drenaje linfático, presentación en frasco gotero ámbar."
    },
    {
      "id": "sumi_eso_riper",
      "name": "Sumi Eso Riper",
      "description": "Suplemento sublingual de 5-carnosina para reflujo gástrico."
    }
  ],
  "defaultVoice": {
    "voiceId": "EXAVITQu4vr4xnSDxMaL",
    "modelId": "eleven_multilingual_v2",
    "stability": 0.40,
    "similarity": 0.85,
    "style": 0.70,
    "speakerBoost": true,
    "speedMultiplier": 1.12
  },
  "language": "es-CL",
  "brandColors": ["#FFE600", "#F5F2ED"],
  "toneRules": {
    "avoid": [
      "voseo argentino",
      "modismos no chilenos",
      "claims médicos absolutos",
      "tono de locutora",
      "tono docente"
    ],
    "prefer": [
      "tono amiga chismosa por WhatsApp",
      "up-talk en preguntas",
      "bajada brusca en reveals",
      "acento chileno suave"
    ]
  },
  "createdAt": "2026-05-16T00:00:00Z",
  "updatedAt": "2026-05-16T00:00:00Z"
}
```

> **NOTA SOBRE EL VOICE ID:** El voice ID `EXAVITQu4vr4xnSDxMaL` es de ejemplo (es la voz "Bella" de ElevenLabs). El owner debe reemplazarlo con el ID real de "Valentina" o la voz que use en producción. Para obtener el ID: dashboard de ElevenLabs > Voices > click en voz > copy voice ID.

## 8.2 presets/educativo_pixar.preset.json

```json
{
  "id": "educativo_pixar",
  "displayName": "Educativo · Doctor Pixar",
  "description": "Video largo (2-5 min) con personaje doctor 3D estilo Pixar en plano fijo, narrador autoritario, subtítulos hook banner + captions inferiores. Ideal TOFU/Problem Aware.",
  
  "classification": {
    "formato": "educativo",
    "hookAngulo": "autoridad",
    "funnelStage": "tofu",
    "awareness": "problem_aware"
  },
  
  "estrategia": "plano_fijo",
  "visualEngine": "imagen4",
  
  "visualStyle": {
    "promptTemplate": "3D Pixar style asian male doctor character, white lab coat with stethoscope, friendly expression, traditional Japanese clinic interior background with shelves and decorative plants, soft natural lighting from window, cinematic depth of field, warm color grading, photorealistic CGI animation style similar to Pixar movies, no text, vertical 9:16 composition with character centered upper body visible",
    "negativePrompt": "anime style, 2D illustration, photograph, realistic photography, harsh lighting, low quality, blurry, text overlay, watermark, multiple characters",
    "aspectRatio": "9:16",
    "referenceImages": []
  },
  
  "subtitles": {
    "style": "word_level_kinetic",
    "font": "Inter",
    "fontSize": 64,
    "color": "#FFFFFF",
    "strokeColor": "#000000",
    "strokeWidth": 4,
    "highlightColor": "#FFE600",
    "position": "bottom",
    "allCaps": false
  },
  
  "defaultDurationSeconds": 120,
  "scenesPerMinute": 0.5,
  
  "composition": {
    "kenBurns": {
      "enabled": true,
      "zoomStart": 1.0,
      "zoomEnd": 1.15,
      "panX": 0,
      "panY": -20
    },
    "backgroundMusic": {
      "enabled": false,
      "volumeDb": -20
    }
  },
  
  "createdAt": "2026-05-16T00:00:00Z",
  "updatedAt": "2026-05-16T00:00:00Z"
}
```

---

# 9. VARIABLES DE ENTORNO

## .env.example

```bash
# ====================================
# APP
# ====================================
# Password único para entrar al sistema (cambialo)
APP_PASSWORD=cambia_esto_por_un_password_real

# Puerto del servidor
PORT=3000

# URL base (para links en correos, etc.)
APP_URL=http://localhost:3000

# ====================================
# DATABASE
# ====================================
DATABASE_URL=file:./db/local.db

# ====================================
# ELEVENLABS (TTS)
# ====================================
# Obtener en: https://elevenlabs.io/app/settings/api-keys
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxx

# ====================================
# OPENAI (Whisper para subtítulos)
# ====================================
# Obtener en: https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# ====================================
# GOOGLE AI (Imagen 4 + Veo 3.1)
# ====================================
# Obtener en: https://aistudio.google.com/app/apikey
GOOGLE_AI_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxx

# (Opcional, solo si usás Vertex AI en vez de Gemini API)
# GOOGLE_PROJECT_ID=tu-project-id
# GOOGLE_APPLICATION_CREDENTIALS=./path/to/service-account.json

# ====================================
# LOGGING
# ====================================
LOG_LEVEL=info  # debug | info | warn | error
```

---

# 10. ROADMAP ACELERADO

## Objetivo: video funcionando HOY

### Bloque A — Setup en frío (~30 min con Claude Code)
- [ ] A.1 Crear estructura monorepo Turborepo + pnpm
- [ ] A.2 Setup Next.js 14 en `apps/web` con Tailwind + shadcn/ui
- [ ] A.3 Setup `packages/core` con interface `Block` + `Pipeline`
- [ ] A.4 Setup `packages/contracts` con TODOS los schemas Zod listados arriba
- [ ] A.5 `.env.example` completo
- [ ] A.6 Crear `brands/vitaly.brand.json` con el JSON de la sección 8.1
- [ ] A.7 Crear `presets/educativo_pixar.preset.json` con el JSON de la sección 8.2
- [ ] A.8 Setup SQLite con Drizzle (tablas: `runs`)

### Bloque B — Pipeline mínimo (~2-3 horas con Claude Code)
- [ ] B.1 Block `script-processor` 
  - Parser de texto con detección de `…` como pausas
  - Test unitario
- [ ] B.2 Block `tts-elevenlabs`
  - Wrapper de API ElevenLabs con voice_settings del brand
  - Output mp3 en `workDir`
  - Calculo de timing por segmento
- [ ] B.3 Block `subtitles-whisper`
  - Upload mp3 a OpenAI Whisper
  - Parse de `verbose_json` con word-level
  - Agrupación de palabras en líneas de 4-5
- [ ] B.4 Block `image-gen-imagen`
  - Construcción de prompt desde preset template
  - Llamada a Google Imagen 4 API
  - Save image.png 1080×1920
- [ ] B.5 Block `compositor-remotion`
  - Composición `PlanoFijo.tsx` con: imagen + audio + subtítulos kinéticos
  - Ken Burns sutil
  - Render a MP4 1080×1920 30fps

### Bloque C — UI mínima (~1-2 horas con Claude Code)
- [ ] C.1 Página `/` con login (password en .env)
- [ ] C.2 Página `/create` con formulario:
  - Selector de preset (lee `packages/presets/*.json`)
  - Textarea para guión
  - Botón "Generar"
- [ ] C.3 Endpoint `/api/generate` que ejecuta pipeline síncronamente
- [ ] C.4 Página `/runs/[id]` con preview MP4 + descarga
- [ ] C.5 Loading state con polling de progreso

### Después de esto funcionando (fases siguientes)
- Multi-escena (Estrategia B)
- Veo 3.1 Lite para B-roll generativo
- Multi-marca con UI editable
- Editor visual de presets (el "lápiz" del desplegable)
- Cola de jobs con BullMQ
- Regeneración por escena
- Sistema de avatares (futuro Growth Guide)

---

# 11. REGLAS INVIOLABLES

## Sobre código
1. TypeScript strict mode activado. No `any` sin justificación.
2. Todo input/output de bloque se valida con Zod.
3. Errores tipados con `Result<T, BlockError>` (neverthrow).
4. Logs estructurados (`pino`) con `runId` siempre incluido.
5. No hardcodear paths, usar `path.join` y env vars.

## Sobre arquitectura
6. Bloques NO se conocen entre sí. Solo dependen de `core` y `contracts`.
7. Presets son JSON, marcas son JSON. **NUNCA en código TypeScript.**
8. Storage en disco para artifacts grandes. DB solo para metadata.
9. Idempotencia: si un bloque falla, retry sin re-ejecutar los anteriores.

## Sobre seguridad
10. API keys SIEMPRE en `.env`. Nunca en código, nunca en commits.
11. `.env` y `storage/` en `.gitignore` desde commit 1.
12. Servidor solo acepta conexiones localhost.

## Lo que NO se hace
13. **No agregar features fuera del scope MVP** sin permiso explícito del owner.
14. **No reemplazar tecnologías decididas** (Next.js, Remotion, ElevenLabs, etc.) sin permiso.
15. **No tocar este documento (`DOCUMENTO_MAESTRO.md`)** sin permiso explícito del owner.
16. **No commitear archivos generados** (audio, video, runs/).

---

# 12. CÓMO USAR ESTE DOCUMENTO CON CLAUDE CODE

## Paso 1 — Preparación

1. Instalar Node 20+ y pnpm:
   ```bash
   # Verificar
   node --version  # debe ser >= 20.x
   npm install -g pnpm
   ```

2. Instalar Claude Code:
   - Visitar https://docs.claude.com/claude-code
   - Seguir instrucciones de instalación para tu OS

3. Tener API keys a mano:
   - ElevenLabs: https://elevenlabs.io/app/settings/api-keys
   - OpenAI: https://platform.openai.com/api-keys
   - Google AI Studio: https://aistudio.google.com/app/apikey

4. Crear carpeta del proyecto:
   ```bash
   mkdir video-factory
   cd video-factory
   git init
   mkdir docs
   ```

5. Copiar este documento a la raíz como `DOCUMENTO_MAESTRO.md`

## Paso 2 — Primera sesión con Claude Code

Abrir terminal en `video-factory/` y ejecutar:
```bash
claude
```

Pegar este prompt exacto:

```
Hola Claude. Vas a construir el MVP de Video Factory HOY.

PASO 1 — LECTURA OBLIGATORIA:
Lee completo DOCUMENTO_MAESTRO.md en la raíz. Es la fuente de verdad sobre TODO: 
arquitectura, stack, APIs externas, schemas, presets, marcas, roadmap, y reglas. 
NO empiezes nada hasta haberlo leído entero.

PASO 2 — CONFIRMACIÓN:
Después de leerlo, hazme un resumen muy corto (máximo 6 bullets) de:
- Qué hace el proyecto
- Stack técnico decidido
- Cuáles son los 5 bloques del pipeline
- Cuál es la marca y preset inicial
- Tres reglas inviolables
- Qué hay en Bloque A del roadmap

PASO 3 — CONSTRUCCIÓN (después de mi OK):
Trabajamos el roadmap en orden: Bloque A → Bloque B → Bloque C.

REGLAS DE TRABAJO:
- IR RÁPIDO sin sacrificar arquitectura.
- Bloques A.1 a A.8 juntos, después pausá para mostrarme. 
- Bloques B uno por uno, mostrame al final de cada uno.
- Bloque C todo junto, mostrame el resultado final.
- Commits atómicos en español ("feat: setup monorepo turborepo").
- Si hay decisión que no está en el documento, PREGUNTÁ.
- No instales dependencias adicionales sin confirmarme.

OBJETIVO DE HOY:
Tener un MP4 generado end-to-end con:
- Marca: Vitaly (configurada en brands/vitaly.brand.json)
- Preset: educativo_pixar (configurado en presets/educativo_pixar.preset.json)
- Guión de prueba que yo te paso
- Output: MP4 1080×1920 con imagen Pixar + voz ElevenLabs + subs word-level

Empezá leyendo el documento. Cuando termines, dame el resumen y esperá mi OK 
para arrancar Bloque A.
```

## Paso 3 — Iteración

Después de cada Bloque completado:
1. Probá lo que se construyó
2. Si hay algo que no funciona, pegale el error literal a Claude Code
3. Hacé commit antes de pasar al siguiente Bloque
4. Si necesitás un break, hacé `git status` para verificar que todo está limpio

## Paso 4 — Sesiones siguientes

Después del primer día, cuando arranques una sesión nueva:

```bash
cd video-factory
claude
```

Pegar:
```
Hola Claude. Continuamos con Video Factory.
1. Lee DOCUMENTO_MAESTRO.md completo.
2. Hacé git log --oneline para ver dónde quedamos.
3. Decime en qué fase del roadmap estamos y cuál es el próximo paso.
4. Esperá mi OK antes de empezar.
```

## Paso 5 — Si algo se rompe

Si en algún momento Claude Code se traba o hace algo raro:

1. **Pará la acción**: "Para. Resumime qué estás intentando hacer."
2. **Verificá**: ¿está dentro del scope del roadmap?
3. **Si no**: "Eso no está en el roadmap. Volvé al punto anterior."
4. **Si es un error técnico**: pegale el error literal completo
5. **Si nada funciona**: 
   - `git status` para ver cambios
   - `git stash` para guardar cambios temporalmente
   - Empezá una sesión nueva con Claude Code

---

# 🎯 RESUMEN EJECUTIVO FINAL

**Qué es:** Herramienta interna para generar videos verticales 9:16 con IA, arquitectura modular de bloques, uso personal del owner para sus marcas D2C.

**Cómo:** Pipeline: Guión → ElevenLabs (voz) → Whisper (subs) → Imagen 4 (imagen) → Remotion (compositor) → MP4

**Con qué:** TypeScript + Next.js 14 + Drizzle + Remotion + APIs (ElevenLabs, OpenAI, Google AI)

**Cuánto cuesta cada video:** ~$0.35 USD (~$0.30 voz + $0.003 subs + $0.05 imagen)

**Cuándo:** Tener algo funcionando HOY, después iterar.

**Cómo usar este doc:** Pegárselo a Claude Code como contexto, seguir el roadmap, ir rápido.

---

*Documento maestro v1.0 — Mayo 2026*
