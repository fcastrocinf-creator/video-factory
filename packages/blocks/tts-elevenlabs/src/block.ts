import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  ParsedScriptSchema,
  type AudioTrack,
  type ParsedScript,
} from '@video-factory/contracts';
import { ElevenLabsApiError, ElevenLabsClient } from './client.js';
import { buildPrompt, computeSegmentTimings } from './timing.js';

export interface TtsElevenLabsBlockOptions {
  client?: ElevenLabsClient;
}

export class TtsElevenLabsBlock implements Block<ParsedScript, AudioTrack> {
  readonly name = 'tts-elevenlabs';
  readonly version = '1.0.0';
  readonly description =
    'Genera audio mp3 con ElevenLabs API usando voice_settings de la marca activa.';

  constructor(private readonly options: TtsElevenLabsBlockOptions = {}) {}

  validateInput(input: unknown): Result<ParsedScript, Error> {
    const parsed = ParsedScriptSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`ParsedScript inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: ParsedScript, ctx: BlockContext): Promise<Result<AudioTrack, BlockError>> {
    if (!ctx.brand) {
      return err(
        new BlockError(
          this.name,
          'MISSING_BRAND',
          'BlockContext sin brand. El bloque tts-elevenlabs necesita brand.defaultVoice.',
          false,
        ),
      );
    }

    const apiKey = process.env['ELEVENLABS_API_KEY'];
    const client = this.options.client ?? (apiKey ? new ElevenLabsClient({ apiKey }) : null);
    if (!client) {
      return err(
        new BlockError(
          this.name,
          'MISSING_API_KEY',
          'Falta la variable de entorno ELEVENLABS_API_KEY.',
          false,
        ),
      );
    }

    const voice = ctx.brand.defaultVoice;
    const prompt = buildPrompt(input.segments);

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        voiceId: voice.voiceId,
        modelId: voice.modelId,
        promptLength: prompt.length,
      },
      'tts-elevenlabs:requesting',
    );

    let audioBuffer: Buffer;
    try {
      audioBuffer = await client.synthesize({
        voiceId: voice.voiceId,
        modelId: voice.modelId,
        text: prompt,
        voiceSettings: {
          stability: voice.stability,
          similarity_boost: voice.similarity,
          style: voice.style,
          use_speaker_boost: voice.speakerBoost,
        },
      });
    } catch (error) {
      const retryable = error instanceof ElevenLabsApiError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof ElevenLabsApiError ? `API_${error.statusCode}` : 'API_CALL_FAILED';
      return err(
        new BlockError(this.name, code, `Error llamando a ElevenLabs: ${message}`, retryable, error),
      );
    }

    await mkdir(ctx.workDir, { recursive: true });
    const audioPath = join(ctx.workDir, 'audio.mp3');
    await writeFile(audioPath, audioBuffer);

    const durationSeconds = input.estimatedDurationSeconds;
    const segments = computeSegmentTimings(input.segments, durationSeconds);

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        audioPath,
        durationSeconds,
        audioBytes: audioBuffer.length,
        segmentCount: segments.length,
      },
      'tts-elevenlabs:audio_saved',
    );

    const audioTrack: AudioTrack = {
      filePath: audioPath,
      durationSeconds,
      sampleRate: 44100,
      channels: 1,
      format: 'mp3',
      segments,
    };

    return ok(audioTrack);
  }
}

export const ttsElevenLabs = new TtsElevenLabsBlock();
