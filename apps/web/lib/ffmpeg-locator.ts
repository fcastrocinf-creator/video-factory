// Localizador del binario ffmpeg.
//
// La app usa ffmpeg para:
//   - Extraer keyframes de videos (frame-extractor.ts)
//   - Generar GIF preview de runs completados (preset-preview-generator.ts)
//
// No requerimos ffmpeg instalado globalmente: Remotion (que ya es dep transitiva)
// trae el binario bundled. Lo localizamos dinámicamente buscando en varios paths
// típicos según platform/arch:
//   1. node_modules/@remotion/compositor-{plat-arch}/ffmpeg(.exe)  (npm/yarn flat)
//   2. node_modules/.pnpm/@remotion+compositor-...@VERSION/node_modules/...  (pnpm)
//   3. node_modules/{compositor-name}/ffmpeg(.exe)  (otro layout)
//   4. fallback: 'ffmpeg' / 'ffmpeg.exe' en PATH
//
// Cacheamos el resultado al primer hit para evitar I/O repetido.

import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedPath: string | null = null;

const PLATFORM_MAP: Record<string, string> = {
  'win32-x64': 'compositor-win32-x64-msvc',
  'linux-x64': 'compositor-linux-x64-gnu',
  'linux-arm64': 'compositor-linux-arm64-gnu',
  'darwin-x64': 'compositor-darwin-x64',
  'darwin-arm64': 'compositor-darwin-arm64',
};

function safeReaddirSync(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

export function findFfmpegPath(): string {
  if (cachedPath) return cachedPath;

  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const platKey = `${process.platform}-${process.arch}`;
  const compositorDir = PLATFORM_MAP[platKey];

  if (!compositorDir) {
    cachedPath = binName;
    return binName;
  }

  const candidatePaths: string[] = [];

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    // Subimos hasta 7 niveles buscando node_modules
    for (let i = 0; i < 7; i++) {
      const nm = resolve(dir, 'node_modules');
      if (existsSync(nm)) {
        // Layout 1: npm/yarn/pnpm-hoisted — directo en @remotion/
        candidatePaths.push(resolve(nm, '@remotion', compositorDir, binName));

        // Layout 2: pnpm store — node_modules/.pnpm/@remotion+compositor-X@V/...
        const pnpmStore = resolve(nm, '.pnpm');
        if (existsSync(pnpmStore)) {
          for (const entry of safeReaddirSync(pnpmStore)) {
            // El entry es algo como "@remotion+compositor-win32-x64-msvc@4.0.462"
            if (entry.startsWith(`@remotion+${compositorDir}@`)) {
              candidatePaths.push(
                resolve(pnpmStore, entry, 'node_modules', '@remotion', compositorDir, binName),
              );
            }
          }
        }
      }
      dir = resolve(dir, '..');
    }
  } catch {
    // ignored: si fallamos resolviendo paths, caemos al fallback PATH
  }

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      cachedPath = p;
      return p;
    }
  }

  cachedPath = binName; // fallback: ffmpeg en PATH
  return binName;
}

/**
 * Indica si encontramos un binario ffmpeg bundled (no del PATH). Útil para
 * logs / health checks.
 */
export function isFfmpegBundled(): boolean {
  const p = findFfmpegPath();
  return p.includes('node_modules');
}
