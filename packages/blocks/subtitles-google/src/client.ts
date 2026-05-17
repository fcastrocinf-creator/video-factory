const SPEECH_BASE_URL = 'https://speech.googleapis.com/v1';
const DEFAULT_POLL_INTERVAL_MS = 4000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

export type SpeechEncoding = 'MP3' | 'LINEAR16' | 'FLAC' | 'OGG_OPUS' | 'ENCODING_UNSPECIFIED';

export interface SpeechWord {
  word: string;
  startTime: string; // "1.200s"
  endTime: string;
}

export interface SpeechAlternative {
  transcript: string;
  confidence?: number;
  words?: SpeechWord[];
}

export interface SpeechResult {
  alternatives: SpeechAlternative[];
}

export interface SpeechResponse {
  results: SpeechResult[];
}

export interface OperationError {
  code: number;
  message: string;
}

export interface OperationResponse {
  name: string;
  done?: boolean;
  metadata?: {
    progressPercent?: number;
  };
  response?: SpeechResponse;
  error?: OperationError;
}

export interface TranscribeOptions {
  audioBuffer: Buffer;
  encoding: SpeechEncoding;
  languageCode: string;
  model?: string;
  sampleRateHertz?: number;
  onProgress?: (percent: number) => void;
}

export class GoogleSpeechApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GoogleSpeechApiError';
  }
}

export interface GoogleSpeechClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class GoogleSpeechClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(options: GoogleSpeechClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? SPEECH_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  async transcribe(opts: TranscribeOptions): Promise<SpeechResponse> {
    const audioBase64 = opts.audioBuffer.toString('base64');

    const config: Record<string, unknown> = {
      encoding: opts.encoding,
      languageCode: opts.languageCode,
      enableWordTimeOffsets: true,
      model: opts.model ?? 'latest_long',
    };
    if (opts.sampleRateHertz) {
      config['sampleRateHertz'] = opts.sampleRateHertz;
    }

    const startResp = await this.fetchImpl(
      `${this.baseUrl}/speech:longrunningrecognize?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config, audio: { content: audioBase64 } }),
      },
    );

    if (!startResp.ok) {
      const body = await startResp.text();
      throw new GoogleSpeechApiError(
        `Google Speech longrunningrecognize ${startResp.status} ${startResp.statusText}`,
        startResp.status,
        body,
        startResp.status === 429 || startResp.status >= 500,
      );
    }

    const { name } = (await startResp.json()) as { name?: string };
    if (!name) {
      throw new GoogleSpeechApiError(
        'Respuesta de Google Speech sin operation name.',
        200,
        '',
        false,
      );
    }

    return this.pollOperation(name, opts.onProgress);
  }

  private async pollOperation(
    operationName: string,
    onProgress?: (percent: number) => void,
  ): Promise<SpeechResponse> {
    const deadline = Date.now() + this.pollTimeoutMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));

      const resp = await this.fetchImpl(
        `${this.baseUrl}/operations/${encodeURIComponent(operationName)}?key=${encodeURIComponent(this.apiKey)}`,
      );
      if (!resp.ok) {
        const body = await resp.text();
        throw new GoogleSpeechApiError(
          `Google Speech operation poll ${resp.status} ${resp.statusText}`,
          resp.status,
          body,
          resp.status === 429 || resp.status >= 500,
        );
      }

      const op = (await resp.json()) as OperationResponse;

      if (op.metadata?.progressPercent !== undefined && onProgress) {
        onProgress(op.metadata.progressPercent);
      }

      if (op.done) {
        if (op.error) {
          throw new GoogleSpeechApiError(
            `Google Speech operation falló: ${op.error.message}`,
            op.error.code,
            JSON.stringify(op.error),
            false,
          );
        }
        if (!op.response) {
          throw new GoogleSpeechApiError(
            'Operation done sin response.',
            200,
            JSON.stringify(op),
            false,
          );
        }
        return op.response;
      }
    }

    throw new GoogleSpeechApiError(
      `Google Speech timeout después de ${this.pollTimeoutMs} ms`,
      408,
      '',
      true,
    );
  }
}

// Parsea strings tipo "1.200s" o "12s" que devuelve la API a segundos numéricos.
export function parseSpeechTime(value: string): number {
  const match = value.match(/^(-?\d+)(?:\.(\d+))?s$/);
  if (!match) return 0;
  const seconds = parseInt(match[1] ?? '0', 10);
  const frac = match[2] ? parseFloat(`0.${match[2]}`) : 0;
  return seconds + frac;
}
