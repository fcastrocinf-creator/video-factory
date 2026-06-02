// CLI: comprensión profunda de un video (Gemini nativo + motion-map + persistencia).
// Uso: npx tsx scripts/video-intelligence.ts "<ruta-al-video>"
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Cargar el .env raíz (GOOGLE_AI_API_KEY, etc.) — tsx no lo hace solo.
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]!]) process.env[m[1]!] = v;
    }
  }
} catch {}

import { analyzeVideoDeep, formatVideoIntelligence } from '../apps/web/lib/video-intelligence';

async function main(): Promise<void> {
  const v = process.argv[2];
  if (!v) {
    console.error('uso: tsx scripts/video-intelligence.ts "<ruta-al-video>"');
    process.exit(2);
    return;
  }
  const t0 = Date.now();
  const report = await analyzeVideoDeep({ videoPath: v });
  console.log(formatVideoIntelligence(report));
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s · guardado en storage/kb/formatos/)`);
}
void main();
