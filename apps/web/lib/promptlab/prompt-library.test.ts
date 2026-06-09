import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  recordWinningPrompt,
  loadWinningPrompts,
  queryBestSeed,
  normalizeTargetKey,
} from './prompt-library';

function tmpPath(): string {
  return resolve(tmpdir(), `promptlab-test-${randomUUID()}.jsonl`);
}

test('normalizeTargetKey: minúsculas, sin acentos, palabras clave', () => {
  const k = normalizeTargetKey('Mujer 40 con el FRASCO, cocina luminosa');
  assert.ok(!k.includes('á'));
  assert.ok(k.split(' ').length > 2);
  assert.ok(normalizeTargetKey('cocina luminosa frasco mujer').includes('cocina'));
});

test('graba y carga (roundtrip)', async () => {
  const path = tmpPath();
  try {
    const id = await recordWinningPrompt(
      { mode: 'crear', targetKey: 'cocina frasco mujer', prompt: 'PROMPT A', score: 90, byDimension: {}, attempts: 2 },
      { path },
    );
    assert.ok(id);
    const all = await loadWinningPrompts({ path });
    assert.equal(all.length, 1);
    assert.equal(all[0]!.prompt, 'PROMPT A');
  } finally {
    await rm(path, { force: true });
  }
});

test('queryBestSeed devuelve el de MAYOR score entre los similares', async () => {
  const path = tmpPath();
  try {
    await recordWinningPrompt({ mode: 'crear', targetKey: 'cocina frasco mujer luminosa', prompt: 'P1', score: 80, byDimension: {}, attempts: 1 }, { path });
    await recordWinningPrompt({ mode: 'crear', targetKey: 'cocina frasco mujer luminosa', prompt: 'P2', score: 92, byDimension: {}, attempts: 3 }, { path });
    await recordWinningPrompt({ mode: 'ripear', targetKey: 'cocina frasco mujer luminosa', prompt: 'OTRO-MODO', score: 99, byDimension: {}, attempts: 1 }, { path });
    const seed = await queryBestSeed({ mode: 'crear', targetKey: 'cocina frasco mujer luminosa' }, { path });
    assert.equal(seed?.prompt, 'P2'); // mayor score, mismo modo
  } finally {
    await rm(path, { force: true });
  }
});

test('queryBestSeed devuelve null si no hay solapamiento suficiente', async () => {
  const path = tmpPath();
  try {
    await recordWinningPrompt({ mode: 'crear', targetKey: 'playa surf atardecer sol', prompt: 'P1', score: 90, byDimension: {}, attempts: 1 }, { path });
    const seed = await queryBestSeed({ mode: 'crear', targetKey: 'oficina laptop reunion ejecutivo' }, { path });
    assert.equal(seed, null);
  } finally {
    await rm(path, { force: true });
  }
});

test('respeta el filtro por marca', async () => {
  const path = tmpPath();
  try {
    await recordWinningPrompt({ mode: 'crear', targetKey: 'cocina frasco mujer', brandId: 'vitaly', prompt: 'PV', score: 95, byDimension: {}, attempts: 1 }, { path });
    const seedOther = await queryBestSeed({ mode: 'crear', targetKey: 'cocina frasco mujer', brandId: 'biozentra' }, { path });
    assert.equal(seedOther, null);
    const seedSame = await queryBestSeed({ mode: 'crear', targetKey: 'cocina frasco mujer', brandId: 'vitaly' }, { path });
    assert.equal(seedSame?.prompt, 'PV');
  } finally {
    await rm(path, { force: true });
  }
});
