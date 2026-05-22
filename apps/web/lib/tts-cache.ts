// TTS cache: ahorra costo y tiempo cuando un mismo guion + voz se regenera.
// Layout: storage/tts-cache/<sha256>.mp3
// Key = sha256(scriptText + '\n' + voiceId + '|' + modelId + '|' + speed)
//
// Lookup ANTES de llamar al provider de TTS. Si hit, copiamos el mp3 al workDir
// del run. Si miss, después de generar fresh, lo guardamos al cache para reuse.
//
// El cache es content-addressable: el mismo guion + voz devuelve siempre el
// mismo hash, no necesita invalidación. Si cambia 1 letra, el hash es otro y
// genera fresh.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedScript } from '@video-factory/contracts';
import { STORAGE_DIR } from './paths';

const CACHE_DIR = resolve(STORAGE_DIR, 'tts-cache');

export interface TtsCacheKey {
  scriptText: string;
  voiceId: string;
  modelId: string;
  speedMultiplier: number;
  // 'elevenlabs' o 'openai' — keys distintos por provider porque la voz suena
  // diferente aunque el voiceId sea el mismo string.
  provider: 'elevenlabs' | 'openai';
}

export function ttsCacheKeyHash(key: TtsCacheKey): string {
  const norm = `${key.provider}|${key.voiceId}|${key.modelId}|${key.speedMultiplier.toFixed(3)}|${key.scriptText.trim()}`;
  return createHash('sha256').update(norm, 'utf-8').digest('hex');
}

export function cachePathForKey(key: TtsCacheKey): string {
  return resolve(CACHE_DIR, `${ttsCacheKeyHash(key)}.mp3`);
}

export function ttsCacheKeyFromScript(
  script: ParsedScript,
  voiceId: string,
  modelId: string,
  speedMultiplier: number,
  provider: 'elevenlabs' | 'openai',
): TtsCacheKey {
  // El script efectivo que llega al TTS es la concatenación de segments.
  // Mantenemos esto sincronizado con cómo cada block arma el prompt.
  const scriptText = script.segments.map((s) => s.text).join(' ');
  return { scriptText, voiceId, modelId, speedMultiplier, provider };
}

export async function checkTtsCache(key: TtsCacheKey): Promise<string | null> {
  const path = cachePathForKey(key);
  if (!existsSync(path)) return null;
  try {
    const s = await stat(path);
    if (s.size < 1000) return null; // archivo corrupto / vacío
    return path;
  } catch {
    return null;
  }
}

export async function copyFromCache(cachedPath: string, destPath: string): Promise<void> {
  await mkdir(resolve(destPath, '..'), { recursive: true });
  await copyFile(cachedPath, destPath);
}

export async function saveToCache(srcPath: string, key: TtsCacheKey): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const destPath = cachePathForKey(key);
  await copyFile(srcPath, destPath);
  return destPath;
}
