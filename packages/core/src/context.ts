import type { Logger } from 'pino';
import type { BrandConfig, PresetConfig } from '@video-factory/contracts';

export interface BlockContext {
  readonly runId: string;
  readonly workDir: string;
  readonly logger: Logger;
  readonly brand?: BrandConfig;
  readonly preset?: PresetConfig;
  /**
   * Callback opcional para reportar progreso intra-bloque (0-100 dentro del bloque).
   * Útil para bloques largos como compositor-remotion. La orquestación decide cómo
   * mapear ese 0-100 al progreso global del run.
   */
  readonly onBlockProgress?: (subPercent: number) => void;
}
