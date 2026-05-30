// index.ts — exports del package preview-judge.
//
// API pública:
//   - judgeImage(input, options) → Result<JudgeReport, JudgeError>
//   - JudgeReportSchema (Zod) y types relacionados
//   - SYSTEM_PROMPT (para que tests/debug puedan inspeccionar)

export { judgeImage } from './judge.js';
export {
  JudgeReportSchema,
  JudgeIssueSchema,
  IssueSeveritySchema,
  IssueCategorySchema,
  type JudgeReport,
  type JudgeIssue,
  type IssueSeverity,
  type IssueCategory,
  type JudgeInput,
  type JudgeOptions,
  type JudgeError,
} from './types.js';
export { SYSTEM_PROMPT, buildUserPromptText } from './judge-prompt.js';
export type {
  ClaudeMessage,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeUsage,
} from './claude-client.js';
