// Ingredients visual loop: cierra el círculo entre la biblioteca de assets de
// la marca y el image generator.
//
// Flujo:
//   1. Para cada escena con imagePrompt, decidir si menciona un producto / asset.
//   2. Si sí, llamar a GPT-4o vision con el asset image + el imagePrompt actual.
//   3. GPT-4o devuelve un prompt RE-ESCRITO que describe el asset con detalle
//      visual exacto (forma, color, tipografía visible, dimensiones aparentes).
//   4. Reemplazar imagePrompt en la escena con el prompt refinado.
//   5. gpt-image-1 genera la imagen con un prompt que ya "vio" el producto real.
//
// Costo: 1 llamada GPT-4o vision por escena que usa un asset (~$0.003/escena).
// Para un video de 30 escenas con ~5 product-shots, eso es ~$0.015 extra.
//
// Cache: response cacheado por sha256(assetPath + scenePromptHash) en
// storage/vision-refiner-cache/<hash>.txt. Los runs subsecuentes con la misma
// combinación reutilizan sin nueva llamada.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { BrandConfig, BrandIngredients, Scene, SceneTrack } from '@video-factory/contracts';
import { STORAGE_DIR } from './paths';

type Asset = BrandIngredients['assets'][number];

const CACHE_DIR = resolve(STORAGE_DIR, 'vision-refiner-cache');

/**
 * Heurística para matchear un asset con una escena. Si las palabras clave
 * principales del asset (kind + description) aparecen en el imagePrompt de la
 * escena, es un match.
 *
 * Devuelve el mejor asset (más coincidencias) o null.
 */
function findMatchingAsset(scene: Scene, brand: BrandConfig): Asset | null {
  const assets = brand.ingredients?.assets ?? [];
  if (assets.length === 0) return null;

  const promptLc = scene.imagePrompt.toLowerCase();
  const sceneTextLc = scene.text.toLowerCase();

  // También consideramos productos declarados — si el prompt menciona el nombre
  // del producto, buscamos un asset cuyo kind=product-shot y description matchee.
  const productMentionMap = new Map<string, string>();
  for (const p of brand.products) {
    const nameLc = p.name.toLowerCase();
    if (promptLc.includes(nameLc) || sceneTextLc.includes(nameLc)) {
      productMentionMap.set(p.id, p.name);
    }
  }

  let best: { asset: Asset; score: number } | null = null;
  for (const a of assets) {
    const descLc = a.description.toLowerCase();
    const descKeywords = (descLc.match(/\b[a-záéíóúñ]{4,}\b/g) ?? []).slice(0, 12);
    let score = 0;
    for (const kw of descKeywords) {
      if (promptLc.includes(kw)) score += 1;
    }
    // Boost si el kind es relevante a productos mencionados
    if (productMentionMap.size > 0 && a.kind === 'product-shot') score += 3;
    // Boost si el kind es "logo" o "icon" cuando el prompt menciona la marca
    if (
      a.kind === 'icon' &&
      promptLc.includes(brand.displayName.toLowerCase())
    ) {
      score += 2;
    }
    if (score >= 2 && (!best || score > best.score)) {
      best = { asset: a, score };
    }
  }
  return best?.asset ?? null;
}

function refinerCachePath(assetPath: string, scenePrompt: string): string {
  const hash = createHash('sha256')
    .update(`${assetPath}|${scenePrompt.trim()}`, 'utf-8')
    .digest('hex');
  return resolve(CACHE_DIR, `${hash}.txt`);
}

function imageToDataUrl(path: string, buffer: Buffer): string {
  const ext = extname(path).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.svg'
          ? 'image/svg+xml'
          : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

interface OpenaiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

/**
 * Llama a GPT-4o vision con el asset image + el imagePrompt original, y pide
 * un imagePrompt RE-ESCRITO con descripción visual precisa del asset.
 *
 * Si OPENAI_API_KEY no está seteada, devuelve null (el caller usa el prompt original).
 */
async function refineWithGpt4oVision(
  assetPath: string,
  assetDescription: string,
  scenePrompt: string,
  sceneText: string,
): Promise<string | null> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey || apiKey === 'sk_pendiente') return null;

  // Check cache
  const cachePath = refinerCachePath(assetPath, scenePrompt);
  if (existsSync(cachePath)) {
    try {
      const cached = await readFile(cachePath, 'utf-8');
      if (cached.trim().length > 20) return cached.trim();
    } catch {
      // Si falla, regeneramos
    }
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(assetPath);
  } catch {
    return null;
  }
  // Limitamos tamaño para evitar tokens excesivos (5 MB hard cap pre-encode)
  if (imageBuffer.byteLength > 5 * 1024 * 1024) return null;

  const dataUrl = imageToDataUrl(assetPath, imageBuffer);

  const systemMessage =
    'You rewrite text-to-image prompts so they incorporate the EXACT visual identity of a real brand asset shown in an attached photo. Output: ONLY the rewritten prompt (no preamble, no quotes). Keep it under 90 words. Preserve the original scene description; insert specific visual details from the photo: shape, color, label typography, packaging form, dimensions. Avoid claiming text/logo content the AI cannot reproduce reliably — say "the bottle has an unbranded clean label" if the asset has heavy text.';

  const userMessage = `Original scene prompt (text-to-image): "${scenePrompt}"

Scene narration context: "${sceneText}"

The attached image is the real brand asset. Asset description from the brand library: "${assetDescription}".

Rewrite the scene prompt so the depicted asset matches what you see in the photo (shape, color, packaging form). Keep the ARTISTIC STYLE of the original prompt (illustration, photo-real, watercolor, etc.) and the surrounding scene. Do not add narrative beyond the original.`;

  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemMessage },
      {
        role: 'user',
        content: [
          { type: 'text', text: userMessage },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.4,
    max_tokens: 280,
  };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`OpenAI vision ${resp.status}: ${t.slice(0, 200)}`);
    }
    const json = (await resp.json()) as OpenaiChatResponse;
    const refined = json.choices?.[0]?.message?.content?.trim();
    if (!refined || refined.length < 20) return null;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, refined, 'utf-8');
    return refined;
  } catch {
    return null;
  }
}

/**
 * Procesa un SceneTrack y devuelve uno nuevo con los imagePrompts refinados
 * para las escenas que matchean con assets de la marca.
 *
 * Best-effort: si OPENAI_API_KEY falta o falla la llamada, devuelve el track
 * sin cambios (el pipeline sigue funcionando con los prompts originales).
 */
export async function refineSceneTrackWithIngredients(
  sceneTrack: SceneTrack,
  brand: BrandConfig | undefined,
): Promise<SceneTrack> {
  if (!brand?.ingredients?.assets?.length) return sceneTrack;

  const refined = await Promise.all(
    sceneTrack.scenes.map(async (scene) => {
      const asset = findMatchingAsset(scene, brand);
      if (!asset) return scene;
      const refinedPrompt = await refineWithGpt4oVision(
        asset.path,
        asset.description,
        scene.imagePrompt,
        scene.text,
      );
      if (!refinedPrompt) return scene;
      return { ...scene, imagePrompt: refinedPrompt };
    }),
  );

  return { ...sceneTrack, scenes: refined };
}
