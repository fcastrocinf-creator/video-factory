import { err, ok, type Result } from 'neverthrow';
import type { AnyBlock, Block } from './block.js';
import type { BlockContext } from './context.js';
import { BlockError } from './errors.js';

export class Pipeline {
  private readonly blocks: AnyBlock[] = [];

  use<TIn, TOut>(block: Block<TIn, TOut>): this {
    this.blocks.push(block as unknown as AnyBlock);
    return this;
  }

  async execute(
    initialInput: unknown,
    ctx: BlockContext,
  ): Promise<Result<unknown, BlockError>> {
    let current: unknown = initialInput;

    for (const block of this.blocks) {
      const validated = block.validateInput(current);
      if (validated.isErr()) {
        const error = new BlockError(
          block.name,
          'INVALID_INPUT',
          `Validación de input falló en bloque "${block.name}": ${validated.error.message}`,
          false,
          validated.error,
        );
        ctx.logger.error({ runId: ctx.runId, block: block.name, err: error }, 'pipeline:invalid_input');
        return err(error);
      }

      ctx.logger.info({ runId: ctx.runId, block: block.name }, 'pipeline:block_start');
      const started = Date.now();

      const result = await block.run(validated.value, ctx);

      const durationMs = Date.now() - started;

      if (result.isErr()) {
        ctx.logger.error(
          { runId: ctx.runId, block: block.name, durationMs, err: result.error },
          'pipeline:block_failed',
        );
        return result;
      }

      ctx.logger.info(
        { runId: ctx.runId, block: block.name, durationMs },
        'pipeline:block_done',
      );

      current = result.value;
    }

    return ok(current);
  }

  get length(): number {
    return this.blocks.length;
  }
}
