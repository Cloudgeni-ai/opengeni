// @opengeni/react/usage — usage allowances for people, kept out of the package
// root and the session entry so hosts that don't meter usage never load it.
//
// Member-facing: `useUsage` + `<UsageMeter>` read the signed-in member's own
// `/usage/me` (the session proxy serves exactly that route) and
// `<UsageLimitNotice>` is the calm near/at-limit line for a composer header.
// Admin-facing: `<UsageMemberList>` shows every member against their limit and
// edits it with a share-of-budget slider; your backend saves the rule.
//
// Shares and percentages only by default. Pass `formatAmount` / `amounts` to
// show money, credits, or plan multiples in your own unit.
export { useUsage } from "./hooks/use-usage";
export type { UsageClientLike, UseUsageOptions, UseUsageResult } from "./hooks/use-usage";
export { summarizeUsage, usagePercentLabel } from "./usage/summary";
export type { UsageReading, UsageSummary } from "./usage/summary";
export {
  DEFAULT_ALLOWANCE_LABELS,
  allowanceLabels,
  allowanceResetSentence,
  formatAllowanceDate,
} from "./usage/allowance-copy";
export type { AllowanceLabels, AllowanceScope } from "./usage/allowance-copy";
export { DEFAULT_USAGE_METER_LABELS, UsageMeter, UsageMeterView } from "./components/usage-meter";
export type {
  UsageMeterBaseProps,
  UsageMeterLabels,
  UsageMeterProps,
  UsageMeterViewProps,
} from "./components/usage-meter";
export {
  DEFAULT_USAGE_LIMIT_NOTICE_LABELS,
  UsageLimitNotice,
  UsageLimitNoticeView,
} from "./components/usage-limit-notice";
export type {
  UsageLimitNoticeLabels,
  UsageLimitNoticeProps,
} from "./components/usage-limit-notice";
export {
  DEFAULT_USAGE_MEMBER_LIST_LABELS,
  UsageMemberList,
  describeMemberLimit,
} from "./components/usage-member-list";
export type {
  UsageAmountFormat,
  UsageMemberIdentity,
  UsageMemberListLabels,
  UsageMemberListProps,
} from "./components/usage-member-list";
export type { RenderAllowanceExhausted } from "./timeline/allowance-exhausted-row";
