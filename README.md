# Video Factory

Herramienta interna para generar videos verticales 9:16 (TikTok/Reels) con IA para marcas D2C propias.

> La fuente de verdad del proyecto es [`DOCUMENTO_MAESTRO.md`](./DOCUMENTO_MAESTRO.md). Leerlo antes de tocar código.

## Setup

```powershell
pnpm install
Copy-Item .env.example .env
# Editar .env con las API keys reales
pnpm db:migrate
pnpm dev
```

Abrir <http://localhost:3000>.

## Stack

- TypeScript 5.7 / Node 20+ LTS
- Next.js 14 (App Router) + Tailwind + shadcn/ui
- SQLite + Drizzle ORM
- Turborepo + pnpm workspaces
- Remotion 4.x (render)
- Zod, neverthrow, pino, undici

## Estructura

```
apps/web/                 Next.js 14 (UI + API)
packages/core/            Interface Block + Pipeline
packages/contracts/       Schemas Zod compartidos
packages/blocks/*         Bloques del pipeline (tts, subs, image, compositor, ...)
packages/brands/          Configs JSON de marcas (vitaly, ...)
packages/presets/         Configs JSON de presets visuales
packages/ui/              Componentes React compartidos
db/                       Schema Drizzle y migrations
storage/                  Artifacts generados (gitignored)
docs/                     Documentación de referencia
```

## Comandos comunes

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Levanta apps/web en modo dev |
| `pnpm build` | Build de todos los paquetes |
| `pnpm typecheck` | Type-check completo del monorepo |
| `pnpm test` | Tests (Vitest) |
| `pnpm db:generate` | Genera migrations a partir del schema |
| `pnpm db:migrate` | Aplica migrations a la DB local |
| `pnpm format` | Formatea código con Prettier |
