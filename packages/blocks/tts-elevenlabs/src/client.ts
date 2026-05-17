const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

export interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

export interface SynthesizeOptions {
  voiceId: string;
  modelId: string;
  text: string;
  voiceSettings: ElevenLabsVoiceSettings;
}

export class ElevenLabsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ElevenLabsApiError';
  }
}

export interface ElevenLabsClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ElevenLabsClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? ELEVENLABS_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(opts: SynthesizeOptions): Promise<Buffer> {
    const url = `${this.baseUrl}/text-to-speech/${encodeURIComponent(opts.voiceId)}`;

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: opts.text,
        model_id: opts.modelId,
        voice_settings: opts.voiceSettings,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      throw new ElevenLabsApiError(
        `ElevenLabs API ${response.status} ${response.statusText}`,
        response.status,
        bodyText,
        retryable,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
