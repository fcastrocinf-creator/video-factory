import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cargar las variables de entorno desde la raíz del monorepo (un solo .env compartido).
// Next.js sólo lee .env del cwd de apps/web, así que duplicamos el comportamiento manual.
//
// 25-may-2026: cambio de comportamiento — el loader AHORA SOBREESCRIBE siempre el
// valor de process.env desde el .env raíz. Antes hacía `if (!(key in process.env))`
// que dejaba al .env raíz ser fuente "fallback only" — y algunas vars (como
// ANTHROPIC_API_KEY) terminaban en process.env como string vacío o con valor stale
// de algún arranque previo, impidiendo que el judge IA / editor IA funcionaran.
// El .env del root ES la única fuente de verdad para este monorepo.
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(__dirname, '../../.env');
let loadedCount = 0;
let loadedKeys = [];
if (existsSync(rootEnvPath)) {
  const content = readFileSync(rootEnvPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(' #');
      if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
    }
    // OVERRIDE siempre — el .env raíz es fuente de verdad.
    process.env[key] = value;
    loadedCount++;
    loadedKeys.push(`${key}(${value.length}ch)`);
  }
  // eslint-disable-next-line no-console
  console.log(`[next.config] cargadas ${loadedCount} vars desde ${rootEnvPath}:`);
  // eslint-disable-next-line no-console
  console.log(`  ${loadedKeys.join(', ')}`);
}

// Storage UNIFICADO: toda la memoria/aprendizaje vive en <root>/storage. Antes
// algunos módulos usaban process.cwd() y la memoria se partía entre
// apps/web/storage y la raíz (split-brain). Esta var es la fuente de verdad.
process.env.VF_STORAGE_DIR = resolve(__dirname, '..', '..', 'storage');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    // Remotion bundler/renderer son herramientas Node-only (Chromium headless, esbuild,
    // webpack interno). No deben bundlearse al runtime de Next.js; se cargan dinámicamente
    // en el server cuando el pipeline las invoca.
    serverComponentsExternalPackages: [
      '@remotion/bundler',
      '@remotion/renderer',
      'esbuild',
    ],
  },
  transpilePackages: [
    '@video-factory/core',
    '@video-factory/contracts',
    '@video-factory/ui',
    '@video-factory/block-script-processor',
    '@video-factory/block-tts-elevenlabs',
    '@video-factory/block-tts-openai',
    '@video-factory/block-subtitles-google',
    '@video-factory/block-subtitles-whisper',
    '@video-factory/block-image-gen-imagen',
    '@video-factory/block-image-gen-multi',
    '@video-factory/block-scene-planner',
    '@video-factory/block-scene-validator',
    '@video-factory/block-narrator-analyzer',
    '@video-factory/block-video-gen-veo',
    '@video-factory/block-compositor-remotion',
    // 25-may-2026: agregados para que Next.js los transpile y permita que el
    // env loader (arriba) propague process.env a su runtime. Sin esto, el
    // judge Claude y el editor IA NO veían ANTHROPIC_API_KEY (Test 6/7/8).
    '@video-factory/block-preview-judge',
    '@video-factory/block-post-render-judge',
  ],
  webpack: (config, { isServer }) => {
    // Permite que webpack resuelva imports `./foo.js` a `./foo.ts` (estilo Node ESM
    // pero ejecutado por bundler). Estándar para monorepos TS con `type: module`.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.js', '.ts', '.tsx'],
    };

    // En API routes (server bundles), marcar @remotion/bundler y @remotion/renderer
    // como externals — son Node-only (Chromium headless, esbuild, webpack interno) y
    // no deben bundlearse. `serverComponentsExternalPackages` no cubre API routes,
    // por eso lo hacemos a nivel webpack.
    if (isServer) {
      const externals = config.externals;
      const externalsList = Array.isArray(externals) ? externals : [externals].filter(Boolean);
      externalsList.push({
        '@remotion/bundler': 'commonjs @remotion/bundler',
        '@remotion/renderer': 'commonjs @remotion/renderer',
      });
      config.externals = externalsList;
    }

    return config;
  },
};

export default nextConfig;
