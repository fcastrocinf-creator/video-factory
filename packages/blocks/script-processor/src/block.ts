import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  ScriptInputSchema,
  type ParsedScript,
  type ScriptInput,
} from '@video-factory/contracts';
import { parseScript } from './parser.js';

export class ScriptProcessorBlock implements Block<ScriptInput, ParsedScript> {
  readonly name = 'script-processor';
  readonly version = '1.0.0';
  readonly description =
    'Limpia y parsea el guión, detectando pausas (… 300ms, . ? ! 200ms) y estimando duración total.';

  validateInput(input: unknown): Result<ScriptInput, Error> {
    const parsed = ScriptInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`ScriptInput inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: ScriptInput, ctx: BlockContext): Promise<Result<ParsedScript, BlockError>> {
    try {
      const result = parseScript(input.rawText, { language: input.language });

      ctx.logger.info(
        {
          runId: ctx.runId,
          block: this.name,
          segmentCount: result.segments.length,
          estimatedDurationSeconds: result.estimatedDurationSeconds,
        },
        'script-processor:parsed',
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new BlockError(
          this.name,
          'PARSE_FAILED',
          `Error al parsear el guión: ${message}`,
          false,
          error,
        ),
      );
    }
  }
}

export const scriptProcessor = new ScriptProcessorBlock();
