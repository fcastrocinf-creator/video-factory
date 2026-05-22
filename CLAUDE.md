# Video Factory

Herramienta interna para generar videos verticales 9:16 (ads TikTok/Reels) para
marcas D2C (Vitaly, Nelo). Funcionalidad "Ripear": adapta el anuncio de otra
marca al producto propio.

Monorepo TypeScript: Next.js 14 · Remotion 4.x · Drizzle ORM + libsql · pnpm.

## Continuidad entre sesiones

**Si retomas trabajo de una conversación anterior, lee primero `HANDOFF.md`** (en
esta misma carpeta). Contiene el estado completo del proyecto, los bugs conocidos,
los archivos clave, los comandos operativos y los próximos pasos. Se actualiza al
final de cada sesión grande.

## Reglas

- **Idioma:** español neutro — formas con "tú", sin argentinismos.
- Tras editar archivos `apps/web/lib/*.ts`, reinicia `pnpm dev` si el cambio no se
  refleja: Next.js cachea los módulos del lado server.
- No commitear ni correr operaciones destructivas sin que el usuario lo pida.

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
- `DOCUMENTO_MAESTRO.md` — documento de arquitectura original (fuente de verdad)
- `HANDOFF.md` — estado de traspaso entre sesiones
