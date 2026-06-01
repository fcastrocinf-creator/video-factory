// OpenAI TTS — fallback automático cuando ElevenLabs agota su quota mensual.
//
// Precios OpenAI TTS (al 2026):
//   - tts-1:    $15.00/M chars (standard quality)
//   - tts-1-hd: $30.00/M chars (mejor naturalidad)
//
// Voces disponibles (mapeo a gender):
//   - alloy:   neutral, leve female
//   - echo:    male warm
//   - fable:   male British (más narrativo)
//   - onyx:    male deep (autoritativo, ideal para "doctor")
//   - nova:    female young (energetic)
//   - shimmer: female soft
//
// Para el caso de Vitaly con narrador Dr. Hiroshi (male, autoritativo):
//   → "onyx" (deep male) es la mejor opción

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  ParsedScriptSchema,
  type AudioTrack,
  type ParsedScript,
} from '@video-factory/contracts';

type OpenaiTtsModel = 'tts-1' | 'tts-1-hd';
type OpenaiVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

const GENDER_TO_VOICE: Record<'male' | 'female' | 'neutral', OpenaiVoice> = {
  male: 'onyx', // deep autoritativo
  female: 'nova', // young energetic
  neutral: 'alloy',
};

export interface TtsOpenaiBlockOptions {
  // Override del modelo (default tts-1 — más barato, calidad decente)
  model?: OpenaiTtsModel;
  // Override de la voz; si no se especifica, se elige según narratorProfile.gender
  voice?: OpenaiVoice;
  // Velocidad de habla 0.25-4.0 (default 1.0)
  speed?: number;
}

interface OpenaiTtsErrorBody {
  error?: { message?: string; type?: string };
}

export class TtsOpenaiBlock implements Block<ParsedScript, AudioTrack> {
  readonly name = 'tts-openai';
  readonly version = '1.0.0';
  readonly description =
    'TTS via OpenAI API (tts-1 / tts-1-hd). Fallback automático cuando ElevenLabs queda sin créditos. Mapea narratorProfile.gender a la voz adecuada (onyx/nova/alloy).';

  constructor(private readonly options: TtsOpenaiBlockOptions = {}) {}

  validateInput(input: unknown): Result<ParsedScript, Error> {
    const parsed = ParsedScriptSchema.safeParse(input);
    if (!parsed.success) return err(new Error(`ParsedScript inválido: ${parsed.error.message}`));
    return ok(parsed.data);
  }

  async run(input: ParsedScript, ctx: BlockContext): Promise<Result<AudioTrack, BlockError>> {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey || apiKey === 'sk_pendiente' || !apiKey.startsWith('sk-')) {
      return err(
        new BlockError(
          this.name,
          'MISSING_API_KEY',
          'OPENAI_API_KEY no configurada o es placeholder. Genera una key real en https://platform.openai.com/api-keys y pégala en .env.',
          false,
        ),
      );
    }

    const model = this.options.model ?? 'tts-1';
    const gender = input.narratorProfile?.gender ?? 'neutral';
    const voice = this.options.voice ?? GENDER_TO_VOICE[gender];
    const speed = this.options.speed ?? 1.0;

    // Concatenamos todos los segments con pausas en SSML-like (OpenAI no soporta SSML,
    // así que usamos texto con ", " y ". " que el modelo respeta como pausas).
    const text = input.segments
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0)
      .join('\n\n'); // doble newline = pausa natural más larga

    ctx.logger.info(
      { runId: ctx.runId, block: this.name, voice, model, speed, charCount: text.length },
      'tts-openai:requesting',
    );

    let buffer: Buffer;
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: 'mp3',
          speed,
        }),
      });
      if (!resp.ok) {
        const bodyText = await resp.text();
        let parsedMsg = bodyText;
        try {
          const parsed = JSON.parse(bodyText) as OpenaiTtsErrorBody;
          parsedMsg = parsed.error?.message ?? bodyText;
        } catch {
          // keep bodyText
        }
        return err(
          new BlockError(
            this.name,
            `API_${resp.status}`,
            `Error llamando a OpenAI TTS: OpenAI API ${resp.status} ${resp.statusText} — ${parsedMsg.slice(0, 200)}`,
            resp.status === 429 || resp.status >= 500,
          ),
        );
      }
      const arrayBuf = await resp.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(new BlockError(this.name, 'API_CALL_FAILED', `OpenAI TTS network error: ${message}`, true));
    }

    await mkdir(ctx.workDir, { recursive: true });
    const audioPath = join(ctx.workDir, 'audio.mp3');
    await writeFile(audioPath, buffer);

    // Estimación: OpenAI no devuelve duración. Aproximamos por caracteres a velocidad
    // promedio (15 chars/segundo en español ≈ 150 wpm), ajustado por `speed`.
    const estimatedSeconds = Math.max(1, text.length / 15 / speed);

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        audioPath,
        bytes: buffer.length,
        estimatedSeconds,
        voice,
        model,
      },
      'tts-openai:audio_saved',
    );

    const audioTrack: AudioTrack = {
      filePath: audioPath,
      durationSeconds: estimatedSeconds,
      sampleRate: 24000, // OpenAI default
      channels: 1,
      format: 'mp3',
      segments: input.segments.map((s, i, arr) => ({
        text: s.text,
        startTimeSeconds: (i * estimatedSeconds) / arr.length,
        endTimeSeconds: ((i + 1) * estimatedSeconds) / arr.length,
      })),
    };
    return ok(audioTrack);
  }
}

export const ttsOpenai = new TtsOpenaiBlock();
