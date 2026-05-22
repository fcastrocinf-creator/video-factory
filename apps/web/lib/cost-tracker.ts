// Cost tracker estimado por run. Acumulamos eventos en memoria durante el run
// y al final persistimos el total a runs.estimated_cost_usd + breakdown.
//
// Precios (USD) — actualizar cuando los proveedores cambien tarifas:

export const TTS_OPENAI_PER_1K_CHARS = 0.015; // tts-1
export const TTS_ELEVENLABS_PER_1K_CHARS = 0.18; // estimado plan Starter
export const OPENAI_IMAGE_MEDIUM_PORTRAIT = 0.04; // gpt-image-1 medium 1024x1536
export const OPENAI_IMAGE_HIGH_PORTRAIT = 0.17; // gpt-image-1 high 1024x1536
export const OPENAI_IMAGE_LOW_PORTRAIT = 0.011; // gpt-image-1 low 1024x1536
export const GEMINI_FLASH_PER_1K_INPUT = 0.000075; // tokens input
export const GEMINI_FLASH_PER_1K_OUTPUT = 0.0003;
export const GEMINI_PRO_PER_1K_INPUT = 0.00125;
export const GEMINI_PRO_PER_1K_OUTPUT = 0.005;
export const GEMINI_VISION_FLAT_PER_IMAGE = 0.001; // estimado conservador

export interface CostEvent {
  kind: 'image-gen' | 'tts' | 'gemini-vision' | 'gemini-text' | 'other';
  provider: string;
  description: string;
  costUsd: number;
  units?: number; // count (images, chars, tokens) — informativo
}

export class CostTracker {
  private events: CostEvent[] = [];

  addImage(provider: 'openai' | 'vertex' | 'aistudio' | 'higgsfield' | 'fal' | 'unknown', quality: 'low' | 'medium' | 'high' = 'medium'): void {
    let cost = 0;
    if (provider === 'openai') {
      cost =
        quality === 'high'
          ? OPENAI_IMAGE_HIGH_PORTRAIT
          : quality === 'low'
            ? OPENAI_IMAGE_LOW_PORTRAIT
            : OPENAI_IMAGE_MEDIUM_PORTRAIT;
    } else if (provider === 'aistudio' || provider === 'vertex') {
      cost = 0.04; // Imagen 4 std ~ similar
    } else if (provider === 'higgsfield') {
      cost = 0.04; // crédito flux pro kontext aprox
    } else if (provider === 'fal') {
      cost = 0.025; // flux pro v1.1 aprox
    }
    this.events.push({
      kind: 'image-gen',
      provider,
      description: `1 imagen (${quality})`,
      costUsd: cost,
      units: 1,
    });
  }

  addTts(provider: 'elevenlabs' | 'openai', charCount: number): void {
    const rate =
      provider === 'openai' ? TTS_OPENAI_PER_1K_CHARS : TTS_ELEVENLABS_PER_1K_CHARS;
    const cost = (charCount / 1000) * rate;
    this.events.push({
      kind: 'tts',
      provider,
      description: `${charCount} chars TTS`,
      costUsd: cost,
      units: charCount,
    });
  }

  addGeminiVision(model: 'flash' | 'pro', images = 1): void {
    const cost = images * GEMINI_VISION_FLAT_PER_IMAGE;
    this.events.push({
      kind: 'gemini-vision',
      provider: `gemini-${model}`,
      description: `${images} imagen(es) analizada(s)`,
      costUsd: cost,
      units: images,
    });
  }

  addGeminiText(model: 'flash' | 'pro', inputChars: number, outputChars: number): void {
    // approx 4 chars = 1 token
    const inTok = inputChars / 4;
    const outTok = outputChars / 4;
    const inRate = model === 'pro' ? GEMINI_PRO_PER_1K_INPUT : GEMINI_FLASH_PER_1K_INPUT;
    const outRate = model === 'pro' ? GEMINI_PRO_PER_1K_OUTPUT : GEMINI_FLASH_PER_1K_OUTPUT;
    const cost = (inTok / 1000) * inRate + (outTok / 1000) * outRate;
    this.events.push({
      kind: 'gemini-text',
      provider: `gemini-${model}`,
      description: `~${Math.round((inTok + outTok))} tokens`,
      costUsd: cost,
    });
  }

  get total(): number {
    return this.events.reduce((sum, e) => sum + e.costUsd, 0);
  }

  get summary(): { totalUsd: number; imageCount: number; ttsChars: number; events: CostEvent[] } {
    return {
      totalUsd: this.total,
      imageCount: this.events.filter((e) => e.kind === 'image-gen').length,
      ttsChars: this.events
        .filter((e) => e.kind === 'tts')
        .reduce((sum, e) => sum + (e.units ?? 0), 0),
      events: this.events,
    };
  }
}
