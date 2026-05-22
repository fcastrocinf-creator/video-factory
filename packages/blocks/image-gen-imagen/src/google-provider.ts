// Wrapper de ImagenClient (Google Generative AI) sobre ImageProvider interface.

import { ImagenApiError, ImagenClient, type ImagenClientOptions } from './client.js';
import {
  fromImagenError,
  type ImageGenerationRequest,
  type ImageProvider,
} from './provider.js';

export interface GoogleImagenProviderOptions extends ImagenClientOptions {
  // Identificador legible. Si se omite, "google-imagen".
  name?: string;
}

export class GoogleImagenProvider implements ImageProvider {
  readonly name: string;
  private readonly client: ImagenClient;

  constructor(opts: GoogleImagenProviderOptions) {
    this.name = opts.name ?? 'google-imagen';
    this.client = new ImagenClient(opts);
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    try {
      return await this.client.generate({
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
        sampleCount: 1,
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
        model: req.model,
      });
    } catch (e) {
      if (e instanceof ImagenApiError) {
        throw fromImagenError(e, this.name);
      }
      throw e;
    }
  }
}
