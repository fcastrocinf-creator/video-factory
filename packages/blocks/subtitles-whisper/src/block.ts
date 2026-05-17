import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  AudioTrackSchema,
  type AudioTrack,
  type SubtitleTrack,
  type SubtitleWord,
} from '@video-factory/contracts';
import { OpenAiApiError, OpenAiWhisperClient, type WhisperResponse } from './client.js';
import { groupWordsIntoLines } from './grouping.js';

export interface SubtitlesWhisperBlockOptions {
  client?: OpenAiWhisperClient;
  maxWordsPerLine?: number;
  language?: string;
}

export class SubtitlesWhisperBlock implements Block<AudioTrack, SubtitleTrack> {
  readonly name = 'subtitles-whisper';
  readonly version = '1.0.0';
  readonly description =
    'Transcribe el audio con OpenAI Whisper (word-level) y agrupa palabras en líneas legibles.';

  constructor(private readonly options: SubtitlesWhisperBlockOptions = {}) {}

  validateInput(input: unknown): Result<AudioTrack, Error> {
    const parsed = AudioTrackSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`AudioTrack inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: AudioTrack, ctx: BlockContext): Promise<Result<SubtitleTrack, BlockError>> {
    const apiKey = process.env['OPENAI_API_KEY'];
    const client = this.options.client ?? (apiKey ? new OpenAiWhisperClient({ apiKey }) : null);
    if (!client) {
      return err(
        new BlockError(
          this.name,
          'MISSING_API_KEY',
          'Falta la variable de entorno OPENAI_API_KEY.',
          false,
        ),
      );
    }

    const language = this.options.language ?? ctx.brand?.language?.split('-')[0] ?? 'es';

    let audioBuffer: Buffer;
    try {
      audioBuffer = await readFile(input.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new BlockError(
          this.name,
          'AUDIO_READ_FAILED',
          `No se pudo leer el audio en ${input.filePath}: ${message}`,
          false,
          error,
        ),
      );
    }

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        audioPath: input.filePath,
        audioBytes: audioBuffer.length,
        language,
      },
      'subtitles-whisper:requesting',
    );

    let response: WhisperResponse;
    try {
      response = await client.transcribe({
        audioBuffer,
        audioFilename: basename(input.filePath),
        audioMimeType: 'audio/mpeg',
        language,
      });
    } catch (error) {
      const retryable = error instanceof OpenAiApiError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof OpenAiApiError ? `API_${error.statusCode}` : 'API_CALL_FAILED';
      return err(new BlockError(this.name, code, `Error llamando a Whisper: ${message}`, retryable, error));
    }

    if (!response.words || response.words.length === 0) {
      return err(
        new BlockError(
          this.name,
          'NO_WORDS_RETURNED',
          'Whisper no devolvió palabras con timestamps. Verificá que el modelo sea "whisper-1" y que el audio no esté vacío.',
          false,
        ),
      );
    }

    const words: SubtitleWord[] = response.words.map((w) => ({
      word: w.word,
      startTimeSeconds: w.start,
      endTimeSeconds: w.end,
    }));

    const lines = groupWordsIntoLines(words, {
      maxWordsPerLine: this.options.maxWordsPerLine ?? 4,
      breakOnSentenceEnd: true,
    });

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        wordCount: words.length,
        lineCount: lines.length,
        whisperDuration: response.duration,
      },
      'subtitles-whisper:transcribed',
    );

    const subtitleTrack: SubtitleTrack = {
      language,
      words,
      lines,
    };

    return ok(subtitleTrack);
  }
}

export const subtitlesWhisper = new SubtitlesWhisperBlock();
