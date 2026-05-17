const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

export interface WhisperResponse {
  task: string;
  language: string;
  duration: number;
  text: string;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

export interface TranscribeOptions {
  audioBuffer: Buffer;
  audioFilename?: string;
  audioMimeType?: string;
  language?: string;
  model?: string;
}

export class OpenAiApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OpenAiApiError';
  }
}

export interface OpenAiWhisperClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiWhisperClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiWhisperClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(opts: TranscribeOptions): Promise<WhisperResponse> {
    if (opts.audioBuffer.length > WHISPER_MAX_BYTES) {
      throw new Error(
        `Audio supera el límite de Whisper (${WHISPER_MAX_BYTES} bytes): recibido ${opts.audioBuffer.length}`,
      );
    }

    const filename = opts.audioFilename ?? 'audio.mp3';
    const mimeType = opts.audioMimeType ?? 'audio/mpeg';

    const formData = new FormData();
    // Convertimos Buffer→Uint8Array<ArrayBuffer> (copia) para satisfacer el tipo BlobPart
    // cuando este módulo se consume desde un tsconfig con lib DOM (apps/web). TS 5.7
    // distingue Buffer<ArrayBufferLike> de Uint8Array<ArrayBuffer> aunque en runtime
    // sean intercambiables.
    formData.append(
      'file',
      new Blob([new Uint8Array(opts.audioBuffer)], { type: mimeType }),
      filename,
    );
    formData.append('model', opts.model ?? 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    if (opts.language) {
      formData.append('language', opts.language);
    }

    const url = `${this.baseUrl}/audio/transcriptions`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      throw new OpenAiApiError(
        `OpenAI Whisper API ${response.status} ${response.statusText}`,
        response.status,
        bodyText,
        retryable,
      );
    }

    const data = (await response.json()) as WhisperResponse;
    return data;
  }
}
