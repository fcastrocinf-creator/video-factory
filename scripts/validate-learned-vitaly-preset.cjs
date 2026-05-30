// scripts/validate-learned-vitaly-preset.cjs
// Valida el JSON del preset learned-vitaly contra el schema Zod compilado.
// Confirma que el backfill de styleBoilerplate + forbiddenStyleTerms es
// estructuralmente válido.

const path = require('node:path');
const { readFileSync } = require('node:fs');

const PRESET_PATH = path.resolve(
  __dirname,
  '..',
  'packages',
  'presets',
  'pending',
  'learned-vitaly-media-23faa1f14cc9-bfd664eb.preset.json',
);

const SCHEMA_DIST = path.resolve(
  __dirname,
  '..',
  'packages',
  'contracts',
  'dist',
  'preset.schema.js',
);

(async () => {
  let schema;
  try {
    schema = require(SCHEMA_DIST);
  } catch (e) {
    console.error(`✗ No se pudo cargar el schema compilado en ${SCHEMA_DIST}`);
    console.error('  Probablemente falta `pnpm --filter @video-factory/contracts build`');
    console.error(`  Detalle: ${e.message}`);
    process.exit(1);
  }
  const { PresetConfigSchema } = schema;
  if (!PresetConfigSchema) {
    console.error('✗ PresetConfigSchema no exportado por el bundle compilado');
    process.exit(1);
  }

  const raw = readFileSync(PRESET_PATH, 'utf-8');
  const json = JSON.parse(raw);
  const result = PresetConfigSchema.safeParse(json);
  if (!result.success) {
    console.error('✗ FAILED:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }
  console.log('✓ Preset learned-vitaly válido contra schema actualizado');
  console.log(`  styleBoilerplate: ${result.data.visualStyle.styleBoilerplate ? '✓ presente (' + result.data.visualStyle.styleBoilerplate.length + ' chars)' : '✗ ausente'}`);
  console.log(`  forbiddenStyleTerms: ${result.data.visualStyle.forbiddenStyleTerms ? '✓ presente (' + result.data.visualStyle.forbiddenStyleTerms.length + ' terms)' : '✗ ausente'}`);
  console.log(`  animationLayers: ${result.data.visualStyle.animationLayers ? '✓ presente' : '— ausente (esperado para b-roll-static)'}`);
})();
