// Verifica que el Error Memory funciona end-to-end:
// 1. La KB tiene N entradas históricas
// 2. queryRelevantErrors devuelve las relevantes para un guion lymphatic
// 3. formatLessonsLearned produce el bloque "AVOID PATTERNS"
// 4. scene-planner inyectaría ese bloque (en este test simulamos sin llamar a Gemini)

import { loadAllErrors, queryRelevantErrors, formatLessonsLearned } from '@video-factory/core';

async function main() {
  const all = await loadAllErrors();
  console.log(`KB actual: ${all.length} entradas`);
  console.log();

  // Caso: nuevo guion sobre sistema linfático (similar al original)
  const relevant = await queryRelevantErrors({
    keywords: ['linfático', 'lymphatic', 'colapsado', 'ojeras'],
    topK: 10,
  });
  console.log(`Errores relevantes encontrados para query "linfático/lymphatic/ojeras": ${relevant.length}`);
  for (const e of relevant.slice(0, 5)) {
    console.log(`  - [${e.errorCategory}] score=${e.validatorScore} | "${e.errorDescription.slice(0, 100)}..."`);
  }
  console.log();

  const lessons = formatLessonsLearned(relevant);
  console.log('--- BLOQUE LESSONS LEARNED que se inyectaría al system prompt ---');
  console.log(lessons || '(vacío - no hay errores relevantes)');
  console.log('--- fin del bloque ---');

  console.log();
  console.log(`✓ Feedback loop funcional: ${relevant.length > 0 ? 'SÍ' : 'NO (sin errores relevantes en KB)'}`);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
