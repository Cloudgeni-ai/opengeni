import type {
  MemberAllowanceDefault,
  MemberAllowanceRule,
  MemberAllowanceUsage,
  WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";
import { Slider } from "radix-ui";
import { useId, useMemo, useState, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { usagePercentLabel } from "../usage/summary";

/** How a member is named in the list. Usage rows carry only a subject id. */
export type UsageMemberIdentity = {
  name: string;
  /** A second line: an email, a role, or "You". */
  detail?: string | null | undefined;
};

/**
 * Opt in to fixed-amount limits. Amounts are USD micros on the wire; your
 * format/parse decide the unit people type ("$50.00", "500 credits").
 */
export type UsageAmountFormat = {
  format: (micros: number) => string;
  /** Returns micros, or null when the text is not a valid amount. */
  parse: (text: string) => number | null;
  /** Shown before the input, for example "$". */
  prefix?: string | undefined;
  /** The amount input's step in the person's unit. */
  step?: number | undefined;
};

export type UsageMemberListLabels = {
  listLabel: string;
  used: (percent: string) => string;
  noLimitUsed: string;
  amounts: (used: string, limit: string) => string;
  nearLimit: string;
  limitReached: string;
  limit: string;
  defaultEqualShare: (percent: string) => string;
  defaultNone: string;
  defaultShare: (percent: string) => string;
  defaultAmount: (amount: string) => string;
  share: (percent: string) => string;
  amount: (amount: string) => string;
  fixedAmountHidden: string;
  edit: (name: string) => string;
  editorTitle: (name: string) => string;
  optionDefault: string;
  optionShare: string;
  optionAmount: string;
  fixedAmountHint: string;
  shareSlider: string;
  shareInput: string;
  amountInput: string;
  equalShareMultiple: (multiple: string) => string;
  sameAsEqualShare: string;
  atBudget: (amount: string) => string;
  save: string;
  saving: string;
  cancel: string;
  saveFailed: string;
  invalidAmount: string;
  totalWithin: (percent: string) => string;
  totalOver: (percent: string) => string;
  oversubscribedHelp: string;
  unlimitedMembers: (count: number) => string;
  empty: string;
};

export const DEFAULT_USAGE_MEMBER_LIST_LABELS: UsageMemberListLabels = {
  listLabel: "Member usage",
  used: (percent) => `${percent}% used`,
  noLimitUsed: "No individual limit",
  amounts: (used, limit) => `${used} of ${limit}`,
  nearLimit: "Near limit",
  limitReached: "Limit reached",
  limit: "Limit",
  defaultEqualShare: (percent) => `Equal share · ${percent}%`,
  defaultNone: "No individual limit",
  defaultShare: (percent) => `Default · ${percent}%`,
  defaultAmount: (amount) => `Default · ${amount}`,
  share: (percent) => `${percent}% of budget`,
  amount: (amount) => `${amount} fixed`,
  fixedAmountHidden: "Fixed amount",
  edit: (name) => `Change limit for ${name}`,
  editorTitle: (name) => `Limit for ${name}`,
  optionDefault: "Default",
  optionShare: "Share of budget",
  optionAmount: "Fixed amount",
  fixedAmountHint: "Each period. Doesn't grow when the budget does.",
  shareSlider: "Share of the workspace budget",
  shareInput: "Share, percent",
  amountInput: "Fixed amount",
  equalShareMultiple: (multiple) => `${multiple}× an equal share`,
  sameAsEqualShare: "About an equal share",
  atBudget: (amount) => `About ${amount} at the current budget`,
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  saveFailed: "Couldn't save the limit. Refresh and try again.",
  invalidAmount: "Enter an amount of zero or more.",
  totalWithin: (percent) => `Member limits add up to ${percent}% of the budget.`,
  totalOver: (percent) => `Member limits add up to ${percent}% of the budget.`,
  oversubscribedHelp:
    "That's allowed: limits are ceilings, not reservations. The workspace budget still caps what everyone spends together.",
  unlimitedMembers: (count) =>
    count === 1
      ? "1 member has no individual limit."
      : `${count} members have no individual limit.`,
  empty: "No members yet.",
};

export type UsageMemberListProps = {
  /** The full roster for one period (`getAllUsage` / every `getUsage` page). */
  usage: WorkspaceUsageResponse;
  /** The workspace's `memberDefault`, to name what "default" means. */
  memberDefault?: MemberAllowanceDefault | null | undefined;
  /** Name a member. Defaults to the external id, then the subject id. */
  describe?: ((member: MemberAllowanceUsage) => UsageMemberIdentity) | undefined;
  /**
   * Save a member's rule (`null` restores the default). Omit for a read-only
   * list. Run it on your backend: member limits need workspace admin authority.
   */
  onChangeRule?:
    | ((member: MemberAllowanceUsage, rule: MemberAllowanceRule) => Promise<void>)
    | undefined;
  /** Opt in to amounts and fixed-amount limits. Shares only without it. */
  amounts?: UsageAmountFormat | undefined;
  labels?: Partial<UsageMemberListLabels> | undefined;
  /** Draw the list's own border. Turn off inside a card that already has one. */
  framed?: boolean | undefined;
  className?: string | undefined;
};

const STATUS_RANK = { exhausted: 0, warning: 1, ok: 2 } as const;

function shareBase(usage: WorkspaceUsageResponse): number {
  return usage.workspace.includedCredits + usage.workspace.grantsRemaining;
}

function formatPercent(value: number): string {
  // One decimal only where a whole number would hide a real difference.
  const scaled = value * 100;
  return Number.isInteger(Math.round(scaled * 10) / 10) || scaled >= 10
    ? String(Math.round(scaled))
    : (Math.round(scaled * 10) / 10).toFixed(1);
}

function formatMultiple(value: number): string {
  return value >= 10 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toString();
}

/** Words for a member's current limit, from their override or the default. */
export function describeMemberLimit(
  member: Pick<MemberAllowanceUsage, "rule" | "limit">,
  context: {
    memberDefault: MemberAllowanceDefault | null | undefined;
    shareBase: number;
    amounts?: UsageAmountFormat | undefined;
    labels?: Partial<UsageMemberListLabels> | undefined;
  },
): string {
  const labels = { ...DEFAULT_USAGE_MEMBER_LIST_LABELS, ...context.labels };
  const ofBudget = (limit: number | null) =>
    limit !== null && context.shareBase > 0 ? formatPercent(limit / context.shareBase) : "0";
  const rule = member.rule;
  if (rule && "share" in rule) return labels.share(formatPercent(rule.share));
  if (rule && "credits" in rule) {
    return context.amounts
      ? labels.amount(context.amounts.format(rule.credits))
      : labels.fixedAmountHidden;
  }
  const fallback = context.memberDefault ?? "none";
  if (fallback === "none" || member.limit === null) return labels.defaultNone;
  if (fallback === "equal_share") return labels.defaultEqualShare(ofBudget(member.limit));
  if ("share" in fallback) return labels.defaultShare(formatPercent(fallback.share));
  return context.amounts
    ? labels.defaultAmount(context.amounts.format(fallback.credits))
    : labels.defaultShare(ofBudget(member.limit));
}

/**
 * Every member's usage against their own limit, with an optional editor:
 * a share-of-budget slider (default), a fixed amount, or the workspace
 * default. Oversubscription is shown, never blocked.
 */
export function UsageMemberList({
  usage,
  memberDefault,
  describe,
  onChangeRule,
  amounts,
  labels: overrides,
  framed = true,
  className,
}: UsageMemberListProps) {
  const labels = { ...DEFAULT_USAGE_MEMBER_LIST_LABELS, ...overrides };
  const base = shareBase(usage);
  const [editing, setEditing] = useState<string | null>(null);
  const name = (member: MemberAllowanceUsage): UsageMemberIdentity =>
    describe?.(member) ?? {
      name: member.externalIdentity?.externalId ?? member.subjectId,
      detail: null,
    };
  const members = useMemo(
    () =>
      [...usage.members].sort(
        (left, right) =>
          STATUS_RANK[left.status] - STATUS_RANK[right.status] || right.used - left.used,
      ),
    [usage.members],
  );
  if (members.length === 0) {
    return <p className={cn("og-root text-og-sm text-og-fg-muted", className)}>{labels.empty}</p>;
  }
  return (
    <div className={cn("og-root flex min-w-0 flex-col gap-3", className)}>
      <AllocationSummary usage={usage} base={base} labels={labels} framed={framed} />
      <ul
        aria-label={labels.listLabel}
        className={cn(
          "divide-y divide-og-border",
          framed && "overflow-hidden rounded-og-md border border-og-border",
        )}
      >
        {members.map((member) => (
          <MemberRow
            key={member.subjectId}
            member={member}
            identity={name(member)}
            usage={usage}
            base={base}
            memberDefault={memberDefault}
            amounts={amounts}
            labels={labels}
            framed={framed}
            editing={editing === member.subjectId}
            onEdit={
              onChangeRule
                ? () =>
                    setEditing((current) =>
                      current === member.subjectId ? null : member.subjectId,
                    )
                : undefined
            }
            onClose={() => setEditing(null)}
            onSave={
              onChangeRule
                ? async (rule) => {
                    await onChangeRule(member, rule);
                    setEditing(null);
                  }
                : undefined
            }
          />
        ))}
      </ul>
    </div>
  );
}

function memberShares(usage: WorkspaceUsageResponse, base: number) {
  let total = 0;
  let unlimited = 0;
  for (const member of usage.members) {
    if (member.limit === null) unlimited += 1;
    else total += base > 0 ? member.limit / base : 0;
  }
  return { total, unlimited };
}

function AllocationSummary({
  usage,
  base,
  labels,
  framed,
}: {
  usage: WorkspaceUsageResponse;
  base: number;
  labels: UsageMemberListLabels;
  framed: boolean;
}) {
  if (base <= 0) return null;
  const { total, unlimited } = memberShares(usage, base);
  const limited = usage.members.length - unlimited;
  const over = total > 1.005;
  // An untouched default (everyone on an equal share, 100% in total) needs no
  // summary; say something only when the split has been shaped or overflows.
  const shaped = usage.members.some((member) => member.rule !== null);
  if (limited === 0 || (!over && !shaped && unlimited === 0)) return null;
  return (
    <div
      data-og-usage-allocation={over ? "oversubscribed" : "within"}
      className={cn(
        "flex min-w-0 flex-col gap-1 text-og-sm",
        framed || over ? "rounded-og-md px-3 py-2" : "pt-1",
        over
          ? "bg-og-status-waiting/8 text-og-fg"
          : framed
            ? "bg-og-surface-1 text-og-fg-muted"
            : "text-og-fg-muted",
      )}
    >
      {limited > 0 ? (
        <AllocationBar total={total} over={over}>
          {over ? labels.totalOver(formatPercent(total)) : labels.totalWithin(formatPercent(total))}
        </AllocationBar>
      ) : null}
      {over ? <p className="text-og-xs text-og-fg-muted">{labels.oversubscribedHelp}</p> : null}
      {unlimited > 0 ? (
        <p className="text-og-xs text-og-fg-muted">{labels.unlimitedMembers(unlimited)}</p>
      ) : null}
    </div>
  );
}

function AllocationBar({
  total,
  over,
  children,
}: {
  total: number;
  over: boolean;
  children: ReactNode;
}) {
  // The track is the budget; past 100% the fill keeps going in a second tone
  // so oversubscription reads as "more promised than exists", not an error.
  const scale = Math.max(1, total);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className={cn(over && "font-medium")}>{children}</p>
      <span aria-hidden className="relative block h-1 overflow-hidden rounded-full bg-og-surface-3">
        <span
          className="absolute inset-y-0 left-0 bg-og-accent/70"
          style={{ width: `${(Math.min(total, 1) / scale) * 100}%` }}
        />
        {over ? (
          <>
            <span
              className="absolute inset-y-0 bg-og-status-waiting"
              style={{ left: `${(1 / scale) * 100}%`, right: 0 }}
            />
            <span
              className="absolute inset-y-[-2px] w-px bg-og-fg"
              style={{ left: `${(1 / scale) * 100}%` }}
            />
          </>
        ) : null}
      </span>
    </div>
  );
}

function MemberRow({
  member,
  identity,
  usage,
  base,
  memberDefault,
  amounts,
  labels,
  framed,
  editing,
  onEdit,
  onClose,
  onSave,
}: {
  framed: boolean;
  member: MemberAllowanceUsage;
  identity: UsageMemberIdentity;
  usage: WorkspaceUsageResponse;
  base: number;
  memberDefault: MemberAllowanceDefault | null | undefined;
  amounts: UsageAmountFormat | undefined;
  labels: UsageMemberListLabels;
  editing: boolean;
  onEdit: (() => void) | undefined;
  onClose: () => void;
  onSave: ((rule: MemberAllowanceRule) => Promise<void>) | undefined;
}) {
  const editorId = useId();
  const limited = member.limit !== null;
  const fraction = member.fraction ?? 0;
  const limitText = describeMemberLimit(member, {
    memberDefault,
    shareBase: base,
    amounts,
    labels,
  });
  return (
    <li className={cn("min-w-0", framed && "bg-og-bg")} data-og-usage-member={member.subjectId}>
      <div
        className={cn(
          "grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_11rem] sm:items-center",
          framed && "px-3.5",
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-og-sm font-medium text-og-fg">{identity.name}</p>
          {identity.detail ? (
            <p className="truncate text-og-xs text-og-fg-subtle">{identity.detail}</p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-baseline justify-between gap-2 text-og-xs">
            <span
              className={cn(
                "tabular-nums",
                member.status === "ok" && "text-og-fg-muted",
                member.status === "warning" && "font-medium text-og-status-waiting",
                member.status === "exhausted" && "font-medium text-og-danger",
              )}
            >
              {limited
                ? member.status === "exhausted"
                  ? labels.limitReached
                  : `${labels.used(usagePercentLabel(fraction))}${
                      member.status === "warning" ? ` · ${labels.nearLimit}` : ""
                    }`
                : labels.noLimitUsed}
            </span>
            {amounts ? (
              <span className="truncate text-og-fg-subtle tabular-nums">
                {limited
                  ? labels.amounts(amounts.format(member.used), amounts.format(member.limit!))
                  : amounts.format(member.used)}
              </span>
            ) : null}
          </div>
          <span
            aria-hidden
            className={cn(
              "relative block h-1 overflow-hidden rounded-full",
              limited ? "bg-og-surface-3" : "bg-transparent",
            )}
          >
            {limited ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  member.status === "ok"
                    ? "bg-og-accent"
                    : member.status === "warning"
                      ? "bg-og-status-waiting"
                      : "bg-og-danger",
                )}
                style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }}
              />
            ) : null}
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2 sm:justify-end">
          <span className="text-og-xs text-og-fg-subtle sm:hidden">{labels.limit}</span>
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              aria-expanded={editing}
              aria-controls={editing ? editorId : undefined}
              aria-label={`${labels.edit(identity.name)}: ${limitText}`}
              className="inline-flex h-8 max-w-full items-center gap-1.5 truncate rounded-og-sm border border-og-border px-2.5 text-og-control text-og-fg transition hover:bg-og-surface-2 focus-visible:outline-2 focus-visible:outline-og-accent pointer-coarse:h-10"
            >
              {limitText}
            </button>
          ) : (
            <span className="truncate text-og-xs text-og-fg-muted">{limitText}</span>
          )}
        </div>
      </div>
      {editing && onSave ? (
        <MemberLimitEditor
          id={editorId}
          member={member}
          name={identity.name}
          usage={usage}
          base={base}
          memberDefault={memberDefault}
          amounts={amounts}
          labels={labels}
          framed={framed}
          onCancel={onClose}
          onSave={onSave}
        />
      ) : null}
    </li>
  );
}

type Mode = "default" | "share" | "amount";

/**
 * Opening the editor means "give this person more or less", so a member on
 * the default starts on the share slider at their current share.
 */
function initialMode(rule: MemberAllowanceRule, amounts: UsageAmountFormat | undefined): Mode {
  if (rule === null) return "share";
  if ("share" in rule) return "share";
  return amounts ? "amount" : "share";
}

function MemberLimitEditor({
  id,
  member,
  name,
  usage,
  base,
  memberDefault,
  amounts,
  labels,
  framed,
  onCancel,
  onSave,
}: {
  framed: boolean;
  id: string;
  member: MemberAllowanceUsage;
  name: string;
  usage: WorkspaceUsageResponse;
  base: number;
  memberDefault: MemberAllowanceDefault | null | undefined;
  amounts: UsageAmountFormat | undefined;
  labels: UsageMemberListLabels;
  onCancel: () => void;
  onSave: (rule: MemberAllowanceRule) => Promise<void>;
}) {
  const count = Math.max(1, usage.members.length);
  const equal = 1 / count;
  const currentShare =
    member.rule && "share" in member.rule
      ? member.rule.share
      : member.limit !== null && base > 0
        ? member.limit / base
        : equal;
  const startPercent = Math.min(100, Math.max(0, Math.round(currentShare * 100)));
  const startAmount =
    amounts && member.rule && "credits" in member.rule
      ? stripPrefix(amounts.format(member.rule.credits), amounts.prefix)
      : amounts && member.limit !== null
        ? stripPrefix(amounts.format(member.limit), amounts.prefix)
        : "";
  const [mode, setMode] = useState<Mode>(() => initialMode(member.rule, amounts));
  const [sharePercent, setSharePercent] = useState(startPercent);
  const [amountText, setAmountText] = useState(startAmount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = sharePercent / 100;
  const parsedAmount = amounts && mode === "amount" ? amounts.parse(amountText) : null;
  const defaultLimitText = describeMemberLimit(
    {
      rule: null,
      limit: member.rule === null ? member.limit : defaultLimitFor(memberDefault, base, count),
    },
    { memberDefault, shareBase: base, amounts, labels },
  );
  // Nothing to save until the person moves something: opening the slider on a
  // default member must not silently turn their default into an override.
  const unchanged =
    mode === "default"
      ? member.rule === null
      : mode === "share"
        ? (member.rule === null || "share" in member.rule) && sharePercent === startPercent
        : member.rule !== null && "credits" in member.rule && amountText === startAmount;
  // The roster total if this member's limit changes to the draft.
  const draftLimit =
    mode === "share"
      ? share * base
      : mode === "amount"
        ? parsedAmount
        : defaultLimitFor(memberDefault, base, count);
  const others = usage.members.reduce(
    (sum, other) =>
      other.subjectId === member.subjectId || other.limit === null ? sum : sum + other.limit,
    0,
  );
  const draftTotal = base > 0 && draftLimit !== null ? (others + draftLimit) / base : null;

  async function save() {
    let rule: MemberAllowanceRule;
    if (mode === "default") rule = null;
    else if (mode === "share") rule = { share };
    else {
      if (parsedAmount === null || !Number.isSafeInteger(parsedAmount) || parsedAmount < 0) {
        setError(labels.invalidAmount);
        return;
      }
      rule = { credits: parsedAmount };
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(rule);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : labels.saveFailed);
      setSaving(false);
    }
  }

  const modes: { value: Mode; label: string }[] = [
    { value: "share", label: labels.optionShare },
    ...(amounts ? [{ value: "amount" as const, label: labels.optionAmount }] : []),
    { value: "default", label: labels.optionDefault },
  ];

  return (
    <div
      id={id}
      role="group"
      aria-label={labels.editorTitle(name)}
      className={cn(
        "bg-og-surface-1 px-3.5 py-3",
        framed ? "border-t border-og-border" : "mb-3 rounded-og-md",
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <fieldset className="flex min-w-0 flex-col gap-3" disabled={saving}>
        <legend className="sr-only">{labels.editorTitle(name)}</legend>
        <div
          role="radiogroup"
          aria-label={labels.limit}
          className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-og-sm bg-og-surface-3/60 p-0.5"
        >
          {modes.map((option) => (
            <label
              key={option.value}
              className={cn(
                "relative inline-flex h-7 cursor-pointer items-center rounded-[5px] px-2.5 text-og-control transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-og-accent pointer-coarse:h-9",
                mode === option.value
                  ? "bg-og-bg font-medium text-og-fg shadow-sm"
                  : "text-og-fg-muted hover:text-og-fg",
              )}
            >
              <input
                type="radio"
                name={`${id}-mode`}
                value={option.value}
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>

        {mode === "share" ? (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <Slider.Root
                value={[sharePercent]}
                min={0}
                max={100}
                step={1}
                onValueChange={(next) => setSharePercent(next[0] ?? 0)}
                data-og-share-slider=""
                className="relative flex h-6 min-w-0 flex-1 touch-none items-center select-none pointer-coarse:h-10"
              >
                <Slider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-og-surface-3">
                  <Slider.Range className="absolute h-full rounded-full bg-og-accent" />
                </Slider.Track>
                {count > 1 ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-og-fg-subtle"
                    style={{ left: `${equal * 100}%` }}
                  />
                ) : null}
                <Slider.Thumb
                  aria-label={labels.shareSlider}
                  aria-valuetext={`${sharePercent}%`}
                  className="block size-4 rounded-full border-2 border-og-accent bg-og-bg shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent pointer-coarse:size-6"
                />
              </Slider.Root>
              <label className="flex shrink-0 items-center gap-1 text-og-sm text-og-fg">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  value={sharePercent}
                  aria-label={labels.shareInput}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next))
                      setSharePercent(Math.min(100, Math.max(0, Math.round(next))));
                  }}
                  className="h-8 w-16 rounded-og-sm border border-og-border bg-og-bg px-2 text-right tabular-nums focus-visible:outline-2 focus-visible:outline-og-accent pointer-coarse:h-10"
                />
                %
              </label>
            </div>
            <p className="text-og-xs text-og-fg-subtle" aria-live="polite">
              {[
                count > 1
                  ? Math.abs(share * count - 1) < 0.05
                    ? labels.sameAsEqualShare
                    : labels.equalShareMultiple(formatMultiple(share * count))
                  : null,
                amounts && base > 0
                  ? labels.atBudget(amounts.format(Math.round(share * base)))
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ) : mode === "amount" && amounts ? (
          <div className="flex items-center gap-1 text-og-sm text-og-fg">
            {amounts.prefix ? <span className="text-og-fg-subtle">{amounts.prefix}</span> : null}
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={amounts.step ?? 0.01}
              value={amountText}
              aria-label={labels.amountInput}
              aria-invalid={error === labels.invalidAmount || undefined}
              onChange={(event) => setAmountText(event.target.value)}
              className="h-8 w-28 rounded-og-sm border border-og-border bg-og-bg px-2 tabular-nums focus-visible:outline-2 focus-visible:outline-og-accent pointer-coarse:h-10"
            />
            <span className="ml-2 text-og-xs text-og-fg-subtle">{labels.fixedAmountHint}</span>
          </div>
        ) : (
          <p className="text-og-sm text-og-fg-muted">{defaultLimitText}</p>
        )}
      </fieldset>
      {draftTotal !== null ? (
        <p
          className={cn("mt-3 text-og-xs", draftTotal > 1.005 ? "text-og-fg" : "text-og-fg-subtle")}
        >
          {draftTotal > 1.005 ? (
            <>
              <span className="font-medium">{labels.totalOver(formatPercent(draftTotal))}</span>{" "}
              <span className="text-og-fg-muted">{labels.oversubscribedHelp}</span>
            </>
          ) : (
            labels.totalWithin(formatPercent(draftTotal))
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-og-xs text-og-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-8 items-center rounded-og-sm px-3 text-og-control text-og-fg transition hover:bg-og-surface-2 focus-visible:outline-2 focus-visible:outline-og-accent disabled:opacity-50 pointer-coarse:h-10"
        >
          {labels.cancel}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || unchanged}
          className="inline-flex h-8 items-center rounded-og-sm border border-og-primary-border bg-og-primary px-3 text-og-control font-medium text-og-primary-fg transition hover:bg-og-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
        >
          {saving ? labels.saving : labels.save}
        </button>
      </div>
    </div>
  );
}

function stripPrefix(text: string, prefix: string | undefined): string {
  const plain = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return plain.replace(/,/g, "");
}

/** The ceiling the workspace default gives one member (null: none). */
function defaultLimitFor(
  memberDefault: MemberAllowanceDefault | null | undefined,
  base: number,
  count: number,
): number | null {
  const fallback = memberDefault ?? "none";
  if (fallback === "none") return null;
  if (fallback === "equal_share") return base / count;
  if ("share" in fallback) return fallback.share * base;
  return fallback.credits;
}
