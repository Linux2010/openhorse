/**
 * openhorse - Compact 服务入口
 *
 * 导出所有压缩相关功能。
 */

export {
  compactMessages,
  needsCompact,
  quickCompact,
  type CompactOptions,
  type CompactResult,
} from './compact';

export {
  summaryGenerator,
  type SummaryOptions,
} from './summary-generator';

export {
  AutoCompact,
  getAutoCompact,
  resetAutoCompact,
  type AutoCompactConfig,
} from './auto-compact';

export {
  microCompact,
  ultraCompact,
  roleCompact,
} from './micro-compact';