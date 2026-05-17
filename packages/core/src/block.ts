import type { Result } from 'neverthrow';
import type { BlockContext } from './context.js';
import type { BlockError } from './errors.js';

export interface Block<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  readonly description: string;

  validateInput(input: unknown): Result<TInput, Error>;

  run(input: TInput, ctx: BlockContext): Promise<Result<TOutput, BlockError>>;
}

export type AnyBlock = Block<unknown, unknown>;
