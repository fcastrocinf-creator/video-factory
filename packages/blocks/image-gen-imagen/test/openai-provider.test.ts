import { describe, expect, it, vi } from 'vitest';
import { OpenaiImageProvider } from '../src/openai-provider.js';
import { ImageProviderError } from '../src/provider.js';

// PNG mínimo válido: 1x1 transparente (~70 bytes)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function mockFetch(body: unknown, ok = true, status = 200) {
  const impl: typeof fetch = async () => {
    const respLike = {
      ok,
      status,
      statusText: ok ? 'OK' : 'ERROR',
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      arrayBuffer: async () => new ArrayBuffer(0),
      clone() { return respLike; }, // OpenaiImageProvider llama resp.clone() para retry interno
    };
    return respLike as unknown as Response;
  };
  return vi.fn(impl);
}

describe('OpenaiImageProvider', () => {
  it('rechaza apiKey placeholder sk_pendiente', () => {
    expect(() => new OpenaiImageProvider({ apiKey: 'sk_pendiente' })).toThrow(/placeholder/i);
  });

  it('rechaza apiKey vacía', () => {
    expect(() => new OpenaiImageProvider({ apiKey: '' })).toThrow();
  });

  it('genera buffer desde b64_json', async () => {
    const fetchImpl = mockFetch({ data: [{ b64_json: TINY_PNG_BASE64 }] });
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl });
    const buf = await provider.generate({ prompt: 'test apple', aspectRatio: '9:16' });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(50);
    // Verifica que envió size correcto para 9:16
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.size).toBe('1024x1536');
    expect(body.model).toBe('gpt-image-1');
    expect(body.quality).toBe('medium');
  });

  it('mapea aspect-ratio 16:9 a 1536x1024 (landscape)', async () => {
    const fetchImpl = mockFetch({ data: [{ b64_json: TINY_PNG_BASE64 }] });
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl });
    await provider.generate({ prompt: 'x', aspectRatio: '16:9' });
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.size).toBe('1536x1024');
  });

  it('mapea aspect-ratio 1:1 a 1024x1024', async () => {
    const fetchImpl = mockFetch({ data: [{ b64_json: TINY_PNG_BASE64 }] });
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl });
    await provider.generate({ prompt: 'x', aspectRatio: '1:1' });
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.size).toBe('1024x1024');
  });

  it('marca 400 con "safety system" como isContentRejection', async () => {
    const fetchImpl = mockFetch(
      'Your request was rejected as a result of our safety system.',
      false,
      400,
    );
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl });
    await expect(provider.generate({ prompt: 'x', aspectRatio: '9:16' })).rejects.toMatchObject({
      name: 'ImageProviderError',
      statusCode: 400,
      isContentRejection: true,
    });
  });

  it('marca 429 con insufficient_quota como isDailyQuotaExhausted (chain salta)', async () => {
    const fetchImpl = mockFetch(
      JSON.stringify({
        error: { type: 'insufficient_quota', message: 'You exceeded your current quota' },
      }),
      false,
      429,
    );
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl, internalRetries: 0 });
    await expect(provider.generate({ prompt: 'x', aspectRatio: '9:16' })).rejects.toMatchObject({
      statusCode: 429,
      isDailyQuotaExhausted: true,
      retryable: false,
    });
  });

  it('marca 429 normal (rate-limit) como retryable, NO daily-quota', async () => {
    const fetchImpl = mockFetch('Rate limit reached for requests', false, 429);
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl, internalRetries: 0 });
    await expect(provider.generate({ prompt: 'x', aspectRatio: '9:16' })).rejects.toMatchObject({
      statusCode: 429,
      retryable: true,
      isDailyQuotaExhausted: false,
    });
  });

  it('marca 5xx como retryable', async () => {
    const fetchImpl = mockFetch('Internal Server Error', false, 500);
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl });
    await expect(provider.generate({ prompt: 'x', aspectRatio: '9:16' })).rejects.toMatchObject({
      statusCode: 500,
      retryable: true,
    });
  });

  it('respeta quality option en el body', async () => {
    const fetchImpl = mockFetch({ data: [{ b64_json: TINY_PNG_BASE64 }] });
    const provider = new OpenaiImageProvider({
      apiKey: 'sk-test',
      fetchImpl,
      quality: 'high',
    });
    await provider.generate({ prompt: 'x', aspectRatio: '9:16' });
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.quality).toBe('high');
  });

  it('lanza ImageProviderError si response no tiene data[0]', async () => {
    const fetchImpl = mockFetch({ data: [] });
    const provider = new OpenaiImageProvider({ apiKey: 'sk-test', fetchImpl });
    await expect(provider.generate({ prompt: 'x', aspectRatio: '9:16' })).rejects.toBeInstanceOf(
      ImageProviderError,
    );
  });
});
