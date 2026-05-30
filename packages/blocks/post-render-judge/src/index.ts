// index.ts — exports del post-render-judge.
//
// API pública:
//   - judgeFinalRender(input, options) → Result<FinalRenderReport>
//   - judgeSubtitles(input) → Result<SubtitleJudgeReport>
//   - Types relacionados + Zod schemas

export { judgeFinalRender } from './judge-final.js';
export { judgeSubtitles } from './subtitle-judge.js';
export { buildEditorVerdict, EditorVerdictSchema, type EditorVerdict, type EditorVerdictInput } from './editor-verdict.js';
export {
  EditorActionSchema,
  EditorVerdictV2Schema,
  ActionExtendDurationSchema,
  ActionTrimDurationSchema,
  ActionRegenerateSceneSchema,
  ActionAdjustPromptSchema,
  ActionApproveSchema,
  ActionManualFixSchema,
  type EditorAction,
  type EditorVerdictV2,
  type ActionExtendDuration,
  type ActionTrimDuration,
  type ActionRegenerateScene,
  type ActionAdjustPrompt,
  type ActionApprove,
  type ActionManualFix,
} from './editor-actions.js';
export {
  runEditorLoop,
  type EditorLoopResult,
  type EditorLoopExecutor,
} from './editor-loop.js';
export {
  FinalRenderReportSchema,
  FinalIssueSchema,
  FinalIssueSeveritySchema,
  FinalIssueCategorySchema,
  type FinalRenderReport,
  type FinalIssue,
  type FinalIssueSeverity,
  type FinalIssueCategory,
  type FinalRenderInput,
  type FinalJudgeOptions,
} from './types.js';
export {
  SubtitleJudgeReportSchema,
  SubtitleIssueSchema,
  type SubtitleJudgeReport,
  type SubtitleIssue,
  type SubtitleJudgeInput,
} from './subtitle-judge.js';
export {
  detectBurnedInText,
  BurnedTextDetectionSchema,
  type BurnedTextDetection,
  type DetectBurnedTextOptions,
} from './burned-text-detector.js';
