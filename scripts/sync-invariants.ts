// Sincroniza las INVARIANTES del proyecto (memoria viva) hacia CLAUDE.md, entre
// los marcadores <!-- INVARIANTES:START --> y <!-- INVARIANTES:END -->.
// Fuente de verdad: storage/kb/invariantes.jsonl (o la semilla CORE_INVARIANTS).
// Uso: npx tsx scripts/sync-invariants.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main(): Promise<void> {
  const root = process.cwd();
  // El registro vive en <root>/storage (igual que next.config). Setear ANTES de importar.
  process.env['VF_STORAGE_DIR'] = resolve(root, 'storage');
  const mod = await import(
    pathToFileURL(resolve(root, 'apps', 'web', 'lib', 'kb', 'invariants.ts')).href
  );
  const md: string = await mod.renderInvariantsMarkdown();

  const START = '<!-- INVARIANTES:START -->';
  const END = '<!-- INVARIANTES:END -->';
  const inner = `${START}\n_(Generado por \`scripts/sync-invariants.ts\` desde el registro vivo. No editar a mano.)_\n\n${md}\n${END}`;

  const claudeMdPath = resolve(root, 'CLAUDE.md');
  let content = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';

  if (content.includes(START) && content.includes(END)) {
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    content = content.replace(re, inner);
  } else {
    const section = `\n## Invariantes del proyecto (memoria viva — LEER PRIMERO)\n\n${inner}\n`;
    content = content.trimEnd() + '\n' + section + '\n';
  }
  writeFileSync(claudeMdPath, content, 'utf8');
  const count = md.split('\n').filter((l) => l.trim().startsWith('- ')).length;
  console.log(`CLAUDE.md sincronizado: ${count} invariantes.`);
}

void main();
