import type { Logger } from 'pino';
import type { BrandConfig, PresetConfig } from '@video-factory/contracts';

export interface BlockContext {
  readonly runId: string;
  readonly workDir: string;
  readonly logger: Logger;
  readonly brand?: BrandConfig;
  readonly preset?: PresetConfig;
}
