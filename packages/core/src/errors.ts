export class BlockError extends Error {
  constructor(
    public readonly blockName: string,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BlockError';
  }

  toJSON() {
    return {
      name: this.name,
      blockName: this.blockName,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}
