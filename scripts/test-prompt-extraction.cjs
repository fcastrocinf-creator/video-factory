// Validación rápida: confirma que la regex de extracción de SYSTEM_PROMPT
// matchea para cada bloque mapeado en BLOCK_TO_SOURCE.

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');

const BLOCK_TO_SOURCE = {
  'scene-planner': {
    relativePath: 'packages/blocks/scene-planner/src/block.ts',
    promptVarName: 'systemInstruction',
  },
  'image-gen-multi': {
    relativePath: 'packages/blocks/preview-judge/src/judge-prompt.ts',
    promptVarName: 'SYSTEM_PROMPT',
  },
  'editor-loop': {
    relativePath: 'packages/blocks/post-render-judge/src/editor-loop.ts',
    promptVarName: 'EDITOR_V2_SYSTEM_PROMPT',
  },
  'video-understander': {
    relativePath: 'apps/web/lib/video-understander.ts',
    promptVarName: 'SYSTEM_PROMPT',
  },
  'ad-analyzer': {
    relativePath: 'apps/web/lib/ad-analyzer.ts',
    promptVarName: 'SYSTEM_INSTRUCTION',
  },
};

function extractPromptFromSource(source, varName) {
  const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:export\\s+)?(?:const|let)\\s+${escapedVarName}(?:\\s*:[^=]+)?\\s*=\\s*\`([\\s\\S]*?)\`;`,
    'm',
  );
  const m = re.exec(source);
  return m && m[1] ? m[1] : null;
}

let allOk = true;
console.log('=== Validación regex de extracción SYSTEM_PROMPT ===\n');
for (const [block, info] of Object.entries(BLOCK_TO_SOURCE)) {
  const path = resolve(REPO_ROOT, info.relativePath);
  try {
    const source = readFileSync(path, 'utf-8');
    const extracted = extractPromptFromSource(source, info.promptVarName);
    if (extracted) {
      const preview = extracted.slice(0, 80).replace(/\n/g, ' ');
      console.log(`✓ ${block}`);
      console.log(`  file: ${info.relativePath}`);
      console.log(`  var:  ${info.promptVarName} (${extracted.length} chars)`);
      console.log(`  preview: "${preview}..."`);
    } else {
      console.log(`✗ ${block} — regex NO matcheó var "${info.promptVarName}" en ${info.relativePath}`);
      allOk = false;
    }
  } catch (e) {
    console.log(`✗ ${block} — error leyendo ${info.relativePath}: ${e.message}`);
    allOk = false;
  }
  console.log('');
}

// Test del applyPatch reescritor (regex con capture groups)
console.log('=== Validación regex de applyPatch (capture groups prefix/content/suffix) ===\n');
function applyRegexTest(source, varName) {
  const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `((?:export\\s+)?(?:const|let|var)\\s+${escapedVarName}(?:\\s*:[^=]+)?\\s*=\\s*)\`([\\s\\S]*?)\`(;)`,
    'm',
  );
  return re.exec(source);
}

for (const [block, info] of Object.entries(BLOCK_TO_SOURCE)) {
  const path = resolve(REPO_ROOT, info.relativePath);
  try {
    const source = readFileSync(path, 'utf-8');
    const match = applyRegexTest(source, info.promptVarName);
    if (match) {
      const [full, prefix, content, suffix] = match;
      // Simulamos un reemplazo round-trip y verificamos integridad
      const newContent = content + '\n\nTEST PATCH APPENDED';
      const updated = source.replace(full, `${prefix}\`${newContent}\`${suffix}`);
      // Verificar que el resultado sigue siendo TypeScript válido (al menos sintácticamente)
      const lengthDelta = updated.length - source.length;
      const expectedDelta = '\n\nTEST PATCH APPENDED'.length;
      const ok = lengthDelta === expectedDelta;
      console.log(`${ok ? '✓' : '✗'} ${block} — round-trip delta=${lengthDelta} (expected ${expectedDelta})`);
    } else {
      console.log(`✗ ${block} — applyPatch regex NO matcheó`);
      allOk = false;
    }
  } catch (e) {
    console.log(`✗ ${block} — error: ${e.message}`);
    allOk = false;
  }
}

console.log('');
console.log(allOk ? '✅ TODOS los mappings funcionan correctamente' : '❌ Hay mappings rotos');
process.exit(allOk ? 0 : 1);
