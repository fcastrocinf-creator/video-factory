// scripts/test-editor-flow.cjs
// Test del flujo end-to-end del editor manual de composición (Fase 3 → Fase 4).
//
// Simula lo que haría un humano en /runs/[id]/editor:
//   1) GET /api/runs/[id]/composition  → recibe sceneTrack actual
//   2) Modifica la composition[] de scene 0 (mover/redimensionar/rotar paneles)
//   3) PUT /api/runs/[id]/composition  → guarda + dispara loop de aprendizaje
//   4) Verifica que storage/composition-memory/corrections.jsonl se creó

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const RUN_ID = process.argv[2] || '96bef2a7-6382-4b52-b7aa-5f1475587ea4';
const COOKIE_FILE = path.resolve(__dirname, '..', 'storage', 'probe', 'vf-cookie.txt');

function readCookie() {
  // Formato Netscape de curl -c. Las líneas HttpOnly empiezan con "#HttpOnly_"
  // que NO es un comentario real — hay que tratarlas como datos.
  const raw = fs.readFileSync(COOKIE_FILE, 'utf-8');
  for (let line of raw.split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.replace(/^#HttpOnly_/, '');
    if (line.startsWith('#') || !line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[5] === 'app_auth') {
      return `app_auth=${cols[6]}`;
    }
  }
  throw new Error('Cookie app_auth no encontrada en ' + COOKIE_FILE);
}

const COOKIE = readCookie();

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: 'localhost',
        port: 3000,
        method,
        path: urlPath,
        headers: {
          Cookie: COOKIE,
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== TEST DEL EDITOR DE COMPOSICIÓN ===');
  console.log('Run: ' + RUN_ID);
  console.log('');

  // PASO 1: GET
  console.log('PASO 1: GET /api/runs/' + RUN_ID + '/composition');
  const getResp = await request('GET', `/api/runs/${RUN_ID}/composition`);
  if (getResp.status !== 200) {
    console.error('✗ GET falló: ' + getResp.status + ' ' + JSON.stringify(getResp.body));
    process.exit(1);
  }
  const scene0 = getResp.body.scenes[0];
  console.log('  ✓ ' + getResp.body.scenes.length + ' escenas. Scene 0 tiene ' +
    (scene0.composition?.length ?? 0) + ' piezas en composición libre');
  if (!scene0.composition || scene0.composition.length === 0) {
    console.error('  ✗ Scene 0 NO tiene composition[]. Test no aplica.');
    process.exit(1);
  }
  console.log('  AI proposal:');
  for (const el of scene0.composition) {
    console.log(`    - ${el.id} [${el.kind}] rect(${el.rect.xPct}%, ${el.rect.yPct}%, ${el.rect.widthPct}%×${el.rect.heightPct}%) zIndex=${el.zIndex ?? 0}`);
  }
  console.log('');

  // PASO 2: simular ediciones humanas — mover panel-top, rotar panel-mid, opacity panel-side
  console.log('PASO 2: simulando 3 ajustes humanos sobre los 3 paneles');
  const editedComposition = scene0.composition.map((el) => {
    if (el.id === 'panel-top') {
      return {
        ...el,
        rect: { xPct: 8, yPct: 3, widthPct: 84, heightPct: 50 },
        zIndex: 2,
        manuallyAdjusted: true,
      };
    }
    if (el.id === 'panel-mid') {
      return {
        ...el,
        rect: { xPct: 5, yPct: 58, widthPct: 42, heightPct: 38 },
        rotationDeg: -3,
        manuallyAdjusted: true,
      };
    }
    if (el.id === 'panel-side') {
      return {
        ...el,
        rect: { xPct: 52, yPct: 58, widthPct: 42, heightPct: 38 },
        rotationDeg: 3,
        opacity: 0.92,
        manuallyAdjusted: true,
      };
    }
    return el;
  });

  // Diff resumido
  const diffsApplied = [];
  for (let i = 0; i < scene0.composition.length; i++) {
    const ai = scene0.composition[i];
    const human = editedComposition[i];
    const dx = (human.rect.xPct - ai.rect.xPct).toFixed(1);
    const dy = (human.rect.yPct - ai.rect.yPct).toFixed(1);
    const dw = (human.rect.widthPct - ai.rect.widthPct).toFixed(1);
    const dh = (human.rect.heightPct - ai.rect.heightPct).toFixed(1);
    const dr = ((human.rotationDeg ?? 0) - (ai.rotationDeg ?? 0)).toFixed(1);
    const dz = (human.zIndex ?? 0) - (ai.zIndex ?? 0);
    const dop = ((human.opacity ?? 1) - (ai.opacity ?? 1)).toFixed(2);
    diffsApplied.push(
      `  - ${ai.id}: Δpos(${dx}%, ${dy}%) Δsize(${dw}%, ${dh}%) Δrot(${dr}°) Δz(${dz}) Δopacity(${dop})`,
    );
  }
  console.log(diffsApplied.join('\n'));
  console.log('');

  // PASO 3: PUT
  console.log('PASO 3: PUT /api/runs/' + RUN_ID + '/composition');
  const putResp = await request('PUT', `/api/runs/${RUN_ID}/composition`, {
    sceneIndex: 0,
    composition: editedComposition,
  });
  if (putResp.status !== 200) {
    console.error('  ✗ PUT falló: ' + putResp.status + ' ' + JSON.stringify(putResp.body));
    process.exit(1);
  }
  console.log('  ✓ Save OK: ' + JSON.stringify(putResp.body));
  console.log('');

  // PASO 4: verificar JSONL
  const jsonlPath = path.resolve(process.cwd(), 'storage', 'composition-memory', 'corrections.jsonl');
  console.log('PASO 4: verificar ' + jsonlPath);
  if (!fs.existsSync(jsonlPath)) {
    console.error('  ✗ corrections.jsonl NO existe');
    process.exit(1);
  }
  const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
  console.log('  ✓ corrections.jsonl existe (' + lines.length + ' líneas)');
  const lastEntry = JSON.parse(lines[lines.length - 1]);
  console.log('  Última entrada:');
  console.log('    id:              ' + lastEntry.id);
  console.log('    correctedAt:     ' + lastEntry.correctedAt);
  console.log('    runId:           ' + lastEntry.runId);
  console.log('    brand:           ' + lastEntry.brand);
  console.log('    preset:          ' + lastEntry.preset);
  console.log('    sceneIndex:      ' + lastEntry.sceneIndex);
  console.log('    narration:       "' + (lastEntry.narration || '').slice(0, 60) + '..."');
  console.log('    elementCorr:     ' + lastEntry.elementCorrections.length + ' elementos');
  console.log('    summary:         ' + lastEntry.summary);
  console.log('');

  console.log('=== ✓ EDITOR + LOOP DE APRENDIZAJE OK ===');
  console.log('Para verificar lección inyectada en próximo rip, mirar logs de composite-layout-detector.');
  process.exit(0);
})().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
