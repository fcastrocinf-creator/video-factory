import { describe, expect, it } from 'vitest';
import { VeoApiError } from '../src/client.js';

describe('VeoApiError', () => {
  it('preserva statusCode, responseBody y retryable', () => {
    const e = new VeoApiError('msg', 429, '{"err":"rate"}', true);
    expect(e.statusCode).toBe(429);
    expect(e.responseBody).toBe('{"err":"rate"}');
    expect(e.retryable).toBe(true);
    expect(e.name).toBe('VeoApiError');
  });
});
