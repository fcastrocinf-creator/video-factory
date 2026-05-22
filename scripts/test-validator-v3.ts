// Test runner: corre Validator v3 contra fixture de casos con respuestas esperadas.
// El objetivo es 100% catch rate en errores conocidos sin false positives en controles.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneValidatorV3 } from '@video-factory/block-scene-validator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

interface FixtureCase {
  id: string;
  imagePath: string;
  text: string;
  imagePrompt: string;
  narratorProfile?: { gender: 'male' | 'female' | 'neutral'; ageRange: string; characterCard: string };
  // What we expect — the validator should detect these specific issue keywords
  expected: {
    verdict: 'pass' | 'regenerate';
    minScore?: number; // expected minimum score (for pass cases)
    maxScore?: number; // expected maximum score (for regen cases)
    mustDetectKeywords?: string[]; // substring matches in issues
  };
  description: string;
}

const fixture: FixtureCase[] = [
  // ============ KNOWN FAILS — validator MUST flag ============
  {
    id: 'feet_oversized_premium-ddad1485_scene_04',
    imagePath: 'storage/runs/premium-ddad1485/scene_04.png',
    text: 'tus piernas pesan, tus zapatos aprietan',
    imagePrompt:
      'Hand-illustrated digital painting, woman sitting on bed taking off socks, swollen feet with pressure marks from tight shoes, sepia watercolor style',
    expected: {
      verdict: 'regenerate',
      maxScore: 70,
      mustDetectKeywords: ['foot', 'feet', 'toe', 'propor'],
    },
    description: 'Pies anatómicamente raros y posiblemente más grandes proporcionalmente',
  },
  {
    id: 'gibberish_label_premium-ddad1485_scene_22',
    imagePath: 'storage/runs/premium-ddad1485/scene_22.png',
    text: 'la fórmula que recomiendo se llama Vitaly Gotas',
    imagePrompt:
      'Hand-illustrated digital painting of Vitaly Gotas amber dropper bottle, clean label with only "VITALY" brand name, sepia watercolor style',
    expected: {
      verdict: 'regenerate',
      maxScore: 75,
      mustDetectKeywords: ['gibberish', 'text', 'illegible'],
    },
    description: 'Botella con texto gibberish bajo VITALY',
  },
  {
    id: 'broken_calendar_premium-ddad1485_scene_25',
    imagePath: 'storage/runs/premium-ddad1485/scene_25.png',
    text: 'en 30 días vas a sentirte tú misma de nuevo',
    imagePrompt:
      'Hand-illustrated digital painting of a calendar showing 30 days, days 1 through 29 crossed out, day 30 circled with a sun symbol, sepia watercolor',
    expected: {
      verdict: 'regenerate',
      maxScore: 70,
      mustDetectKeywords: ['number', 'calendar', 'illogical', 'repeat', 'duplicate', 'sequence'],
    },
    description: 'Calendario con números duplicados/fuera de orden',
  },
  {
    id: 'hand_ambiguous_premium-fd99285f_scene_18',
    imagePath: 'storage/runs/premium-fd99285f/scene_18.png',
    text: 'manos del experto preparando hierbas medicinales',
    imagePrompt:
      'Macro close-up of hands arranging medicinal herbs in porcelain bowls on a wooden table, illustrated style',
    expected: {
      verdict: 'regenerate',
      maxScore: 75,
      mustDetectKeywords: ['hand', 'finger', 'anatomy', 'digit'],
    },
    description: 'Manos con dedos ambiguos/posiblemente incorrectos',
  },
  // ============ KNOWN GOODS — validator MUST pass ============
  {
    id: 'doctor_portrait_GOOD_acdf6c97_scene_10',
    imagePath: 'storage/runs/premium-acdf6c97/scene_10.png',
    text: 'Soy el doctor Hiroshi Sato, especialista en medicina linfática',
    imagePrompt:
      'Cinematic editorial portrait of mature Japanese man around 60, gray hair at temples, white lab coat, black shirt, serene authoritative expression',
    narratorProfile: {
      gender: 'male',
      ageRange: '55-65',
      characterCard:
        'Hombre japonés de unos 60 años, Dr. Hiroshi Sato. Cabello corto y canoso en las sienes, de aspecto pulcro. Viste una bata blanca de médico sobre una camisa formal. Su expresión es serena y autoritaria.',
    },
    expected: { verdict: 'pass', minScore: 80 },
    description: 'CONTROL POSITIVO: retrato editorial del Dr. Sato, debe pasar',
  },
  {
    id: 'doctor_with_bottle_GOOD_acdf6c97_scene_23',
    imagePath: 'storage/runs/premium-acdf6c97/scene_23.png',
    text: 'la fórmula que recomiendo se llama Vitaly Gotas',
    imagePrompt:
      'Doctor Hiroshi Sato (mature Japanese man, gray temple hair, white lab coat over black shirt) holding the VITALY GOTAS amber dropper bottle toward camera, confident expression',
    narratorProfile: {
      gender: 'male',
      ageRange: '55-65',
      characterCard:
        'Hombre japonés de unos 60 años, Dr. Hiroshi Sato. Cabello corto y canoso en las sienes, de aspecto pulcro. Viste una bata blanca de médico sobre una camisa formal. Su expresión es serena y autoritaria.',
    },
    expected: { verdict: 'pass', minScore: 80 },
    description: 'CONTROL POSITIVO: Dr. Sato sosteniendo frasco VITALY GOTAS',
  },
];

async function runOne(c: FixtureCase, validator: SceneValidatorV3): Promise<{ passed: boolean; report: string }> {
  const imageBuffer = await readFile(resolve(REPO_ROOT, c.imagePath));
  const result = await validator.validate({
    text: c.text,
    imagePrompt: c.imagePrompt,
    imageBuffer,
    narratorProfile: c.narratorProfile,
  });

  const lines: string[] = [];
  lines.push(`\n=== ${c.id} ===`);
  lines.push(`Description: ${c.description}`);
  lines.push(`Expected verdict: ${c.expected.verdict}`);
  lines.push(`Got verdict: ${result.verdict} | score=${result.score}`);
  lines.push(`Issues (${result.issues.length}): ${result.issues.slice(0, 5).join(' | ')}`);
  if (result.refinementHint) {
    lines.push(`RefinementHint: ${result.refinementHint.slice(0, 200)}...`);
  }

  let verdictOk = result.verdict === c.expected.verdict;
  let scoreOk = true;
  if (c.expected.minScore !== undefined && result.score < c.expected.minScore) scoreOk = false;
  if (c.expected.maxScore !== undefined && result.score > c.expected.maxScore) scoreOk = false;

  let keywordOk = true;
  if (c.expected.mustDetectKeywords && c.expected.mustDetectKeywords.length > 0) {
    const issuesText = result.issues.join(' ').toLowerCase();
    const hintText = (result.refinementHint ?? '').toLowerCase();
    const allText = issuesText + ' ' + hintText;
    keywordOk = c.expected.mustDetectKeywords.some((kw) => allText.includes(kw.toLowerCase()));
    if (!keywordOk) {
      lines.push(`✗ NONE of expected keywords [${c.expected.mustDetectKeywords.join(', ')}] found in output`);
    }
  }

  const passed = verdictOk && scoreOk && keywordOk;
  lines.push(`Result: ${passed ? '✓ PASS' : '✗ FAIL'} (verdictOk=${verdictOk} scoreOk=${scoreOk} keywordOk=${keywordOk})`);

  return { passed, report: lines.join('\n') };
}

async function main() {
  const validator = new SceneValidatorV3();
  if (!validator.isAvailable()) {
    console.error('GOOGLE_AI_API_KEY missing');
    process.exit(1);
  }

  console.log(`Running ${fixture.length} test cases against Validator v3...`);
  const results = [];
  for (const c of fixture) {
    try {
      const r = await runOne(c, validator);
      console.log(r.report);
      results.push({ id: c.id, passed: r.passed });
    } catch (e) {
      console.log(`\n=== ${c.id} ===\nERROR: ${(e as Error).message}`);
      results.push({ id: c.id, passed: false });
    }
  }

  const passCount = results.filter((r) => r.passed).length;
  const total = results.length;
  const pct = ((passCount / total) * 100).toFixed(0);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RECALL: ${passCount}/${total} (${pct}%)`);
  console.log(`${'='.repeat(60)}`);

  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}`);
  }

  process.exit(passCount === total ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
