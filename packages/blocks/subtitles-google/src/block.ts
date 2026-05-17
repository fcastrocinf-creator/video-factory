import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  AudioTrackSchema,
  type AudioTrack,
  type SubtitleTrack,
  type SubtitleWord,
} from '@video-factory/contracts';
import {
  GoogleSpeechApiError,
  GoogleSpeechClient,
  parseSpeechTime,
  type SpeechResponse,
} from './client.js';
import { groupWordsIntoLines } from './grouping.js';

export interface SubtitlesGoogleBlockOptions {
  client?: GoogleSpeechClient;
  maxWordsPerLine?: number;
  language?: string;
  model?: string;
}

export class SubtitlesGoogleBlock implements Block<AudioTrack, SubtitleTrack> {
  readonly name = 'subtitles-google';
  readonly version = '1.0.0';
  readonly description =
    'Transcribe el audio con Google Cloud Speech-to-Text (word-level) usando long-running operation.';

  constructor(private readonly options: SubtitlesGoogleBlockOptions = {}) {}

  validateInput(input: unknown): Result<AudioTrack, Error> {
    const parsed = AudioTrackSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`AudioTrack inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: AudioTrack, ctx: BlockContext): Promise<Result<SubtitleTrack, BlockError>> {
    const apiKey = process.env['GOOGLE_SPEECH_API_KEY'] ?? process.env['GOOGLE_AI_API_KEY'];
    const client = this.options.client ?? (apiKey ? new GoogleSpeechClient({ apiKey }) : null);
    if (!client) {
      return err(
        new BlockError(
          this.name,
          'MISSING_API_KEY',
          'Falta GOOGLE_SPEECH_API_KEY (o GOOGLE_AI_API_KEY de fallback) con permisos sobre la Speech-to-Text API.',
          false,
        ),
      );
    }

    // Normalización de idioma para Google Speech `latest_long`.
    // El modelo no soporta todas las variantes regionales (ej: es-CL, es-AR, es-CO no van).
    // Mapeamos cualquier variante de español a una soportada (es-ES) para evitar
    // 400 "model not supported for language". Mantiene la fonética Spanish OK
    // independiente del país; el modelo reconoce variantes regionales por igual.
    const rawLang = this.options.language ?? ctx.brand?.language ?? 'es-ES';
    const language = normalizeLanguageForLatestLong(rawLang);

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
      'subtitles-google:requesting',
    );

    let response: SpeechResponse;
    try {
      response = await client.transcribe({
        audioBuffer,
        encoding: 'MP3',
        sampleRateHertz: 44100, // ElevenLabs mp3_44100_128 default
        audioChannelCount: 1, // ElevenLabs default es mono
        languageCode: language,
        // `default` produce transcripción confiable para ElevenLabs MP3 en español.
        // `latest_long` devuelve results vacío con este audio (testeado mayo 2026).
        model: this.options.model ?? 'default',
        onProgress: (percent) => {
          ctx.logger.debug(
            { runId: ctx.runId, block: this.name, percent },
            'subtitles-google:progress',
          );
        },
      });
    } catch (error) {
      const retryable = error instanceof GoogleSpeechApiError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof GoogleSpeechApiError ? `API_${error.statusCode}` : 'API_CALL_FAILED';
      return err(
        new BlockError(this.name, code, `Error llamando a Google Speech: ${message}`, retryable, error),
      );
    }

    const firstAlt = response.results?.[0]?.alternatives?.[0];
    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        resultsCount: response.results?.length ?? 0,
        firstAltHasWords: Boolean(firstAlt?.words?.length),
        firstAltWordCount: firstAlt?.words?.length ?? 0,
        firstAltTranscript: firstAlt?.transcript?.slice(0, 200) ?? null,
        firstAltConfidence: firstAlt?.confidence ?? null,
      },
      'subtitles-google:raw_response',
    );

    const words: SubtitleWord[] = [];
    for (const result of response.results ?? []) {
      const alt = result.alternatives?.[0];
      if (!alt?.words) continue;
      for (const w of alt.words) {
        words.push({
          word: w.word,
          startTimeSeconds: parseSpeechTime(w.startTime),
          endTimeSeconds: parseSpeechTime(w.endTime),
        });
      }
    }

    if (words.length === 0) {
      return err(
        new BlockError(
          this.name,
          'NO_WORDS_RETURNED',
          'Google Speech no devolvió palabras con timestamps. Verificá que el modelo sea "latest_long", que el audio no esté vacío y que el languageCode sea correcto.',
          false,
        ),
      );
    }

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
      },
      'subtitles-google:transcribed',
    );

    return ok({
      language,
      words,
      lines,
    });
  }
}

export const subtitlesGoogle = new SubtitlesGoogleBlock();

// Códigos de idioma soportados por el modelo `latest_long` (parcial, los más comunes).
// Cualquier variante regional fuera de esta lista se mapea al base soportado.
const LATEST_LONG_SUPPORTED = new Set([
  'es-ES',
  'es-US',
  'es-MX',
  'en-US',
  'en-GB',
  'en-AU',
  'pt-BR',
  'pt-PT',
  'fr-FR',
  'fr-CA',
  'de-DE',
  'it-IT',
]);

function normalizeLanguageForLatestLong(lang: string): string {
  if (LATEST_LONG_SUPPORTED.has(lang)) return lang;
  // Mapeo de variantes regionales no soportadas al base más cercano.
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('en')) return 'en-US';
  if (lang.startsWith('pt')) return 'pt-BR';
  if (lang.startsWith('fr')) return 'fr-FR';
  return lang;
}
