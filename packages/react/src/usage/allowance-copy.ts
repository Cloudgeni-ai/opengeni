// Shared, replaceable words for usage allowances. The timeline refusal row
// (session graph) and the opt-in `@opengeni/react/usage` surfaces both read
// these, so a host that renames "workspace" or "admin" does it once.
//
// Product rule: never show raw credit amounts here. Hosts that want money or
// plan multiples opt in with `formatAmount` on the meter components.

/** Which ceiling ran out: the shared workspace pool, or one member's share of it. */
export type AllowanceScope = "workspace" | "member";

export type AllowanceLabels = {
  /** "Usage limit reached" for a member ceiling. */
  memberLimitReachedTitle: string;
  /** "Workspace usage limit reached" for the shared pool. */
  workspaceLimitReachedTitle: string;
  /** Who can fix a member ceiling. */
  memberRemedy: string;
  /** Who can fix the workspace pool. */
  workspaceRemedy: string;
  /** "Resets Nov 1". `date` is already formatted by `formatDate`. */
  resets: (date: string) => string;
  /** Shown when a ceiling has no automatic reset. */
  noReset: string;
  /** Formats a reset instant for `resets`. Defaults to a short local date. */
  formatDate: (iso: string) => string;
};

export function formatAllowanceDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

/** Full local date and time, for a title/tooltip next to the short date. */
export function formatAllowanceInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

export const DEFAULT_ALLOWANCE_LABELS: AllowanceLabels = {
  memberLimitReachedTitle: "Usage limit reached",
  workspaceLimitReachedTitle: "Workspace usage limit reached",
  memberRemedy: "A workspace admin can raise this limit.",
  workspaceRemedy: "An organization admin can raise the workspace budget.",
  resets: (date) => `Resets ${date}.`,
  noReset: "It doesn't reset automatically.",
  formatDate: (iso) => formatAllowanceDate(iso),
};

export function allowanceLabels(overrides?: Partial<AllowanceLabels>): AllowanceLabels {
  return overrides ? { ...DEFAULT_ALLOWANCE_LABELS, ...overrides } : DEFAULT_ALLOWANCE_LABELS;
}

/** "Resets Nov 1." or the no-reset sentence. */
export function allowanceResetSentence(labels: AllowanceLabels, resetsAt: string | null): string {
  return resetsAt === null ? labels.noReset : labels.resets(labels.formatDate(resetsAt));
}
