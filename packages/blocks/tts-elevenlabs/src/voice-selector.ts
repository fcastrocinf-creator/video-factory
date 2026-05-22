import type { ElevenLabsVoiceConfig, NarratorProfile } from '@video-factory/contracts';

// Logger mínimo. No importamos pino para no agregar dep — sólo las funciones que usamos.
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SelectVoiceOptions {
  defaultVoice: ElevenLabsVoiceConfig;
  voiceLibrary: ElevenLabsVoiceConfig[];
  narratorProfile?: NarratorProfile;
  logger?: MinimalLogger;
  runId?: string;
}

/**
 * Selecciona la voz adecuada para narrar este guion:
 *
 * 1. Si no hay narratorProfile o el narratorProfile dice narratorPresent=false:
 *    devuelve defaultVoice de la marca (es voiceover genérico).
 * 2. Si narratorProfile.gender matchea defaultVoice.gender: devuelve defaultVoice.
 * 3. Si NO matchea: busca en voiceLibrary la voz que matchee gender + ageRange
 *    más cercano. Si encuentra, la usa.
 * 4. Si no encuentra match en library: cae a defaultVoice con un warning.
 */
export function selectVoiceForNarrator(opts: SelectVoiceOptions): ElevenLabsVoiceConfig {
  const { defaultVoice, voiceLibrary, narratorProfile, logger, runId } = opts;

  if (!narratorProfile || !narratorProfile.narratorPresent) {
    logger?.info(
      { runId, voice: defaultVoice.label || defaultVoice.voiceId, reason: 'no-narrator' },
      'voice-selector:using_default',
    );
    return defaultVoice;
  }

  if (narratorProfile.gender === defaultVoice.gender || narratorProfile.gender === 'neutral') {
    logger?.info(
      {
        runId,
        voice: defaultVoice.label || defaultVoice.voiceId,
        reason: 'default-matches-narrator',
        narratorGender: narratorProfile.gender,
        defaultGender: defaultVoice.gender,
      },
      'voice-selector:using_default',
    );
    return defaultVoice;
  }

  const candidates = voiceLibrary.filter((v) => v.gender === narratorProfile.gender);
  if (candidates.length === 0) {
    logger?.warn(
      {
        runId,
        narratorGender: narratorProfile.gender,
        defaultGender: defaultVoice.gender,
        libraryCount: voiceLibrary.length,
      },
      'voice-selector:no_match_falling_back_to_default',
    );
    return defaultVoice;
  }

  // Match más cercano por edad: parseamos ageRange como "min-max" y calculamos distancia entre puntos medios.
  const targetMid = ageRangeMidpoint(narratorProfile.ageRange);
  const scored = candidates
    .map((v) => ({ voice: v, dist: Math.abs(ageRangeMidpoint(v.ageRange) - targetMid) }))
    .sort((a, b) => a.dist - b.dist);
  const chosen = scored[0]!.voice;

  logger?.info(
    {
      runId,
      voice: chosen.label || chosen.voiceId,
      reason: 'matched-library-voice',
      narratorGender: narratorProfile.gender,
      narratorAge: narratorProfile.ageRange,
      voiceAge: chosen.ageRange,
    },
    'voice-selector:using_library_match',
  );
  return chosen;
}

function ageRangeMidpoint(range: string): number {
  const m = range.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return 40;
  return (parseInt(m[1]!, 10) + parseInt(m[2]!, 10)) / 2;
}
