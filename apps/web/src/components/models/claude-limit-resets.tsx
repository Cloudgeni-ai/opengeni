import type {
  ClaudeLimitResetGrant,
  ClaudeLimitResets,
  ClaudeSubscriptionUsage,
} from "@opengeni/sdk";
import type { ReactNode } from "react";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { formatAbsoluteTime, useMinuteNow } from "@opengeni/react/ui/relative-time";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";

/*
 * Claude's limit reset grants for one account: what each clears, how many
 * are left, when it expires and whether it can be used now, the way Claude
 * Code 2.1.322 explains them.
 */

/**
 * "Clears the weekly limit", "Clears the Fable limit": named the way Claude
 * Code names them. The weekly included-usage limit is part of the weekly
 * limit, except for a grant that gives back Fable usage.
 */
export function claudeGrantClears(grant: ClaudeLimitResetGrant): string | null {
  const names = new Set<string>();
  if (grant.givesBackWeekly) names.add("Fable");
  for (const id of grant.clears) {
    if (id === "five_hour") names.add("5-hour");
    else if (id === "seven_day") names.add("weekly");
    else if (id === "seven_day_overage_included")
      names.add(grant.givesBackWeekly ? "Fable" : "weekly");
    else if (id === "seven_day_fable") names.add("Fable");
    else if (id === "seven_day_opus") names.add("Opus weekly");
    else if (id === "seven_day_sonnet") names.add("Sonnet weekly");
  }
  const all = [...names];
  if (all.length === 0) return null;
  const last = all.pop()!;
  return all.length === 0
    ? `Clears the ${last} limit.`
    : `Clears the ${all.join(", ")} and ${last} limits.`;
}

/** The grant's own name, or one from what it gives back. */
export function claudeGrantTitle(grant: ClaudeLimitResetGrant): string {
  if (grant.label?.trim()) return grant.label.trim();
  switch (grant.kind) {
    case "session":
      return "5-hour limit reset";
    case "weekly":
      return "Weekly limit reset";
    case "fable":
      return "Fable limit reset";
    default:
      return "Full limit reset";
  }
}

/**
 * Why a grant can't be used now, in Claude Code's terms: the provider's
 * reason, else derived from the status (null: usable now).
 */
export function claudeGrantBlockedReason(
  grant: ClaudeLimitResetGrant,
  status: Pick<ClaudeLimitResets, "atLimit" | "exhausted" | "cooldownUntil">,
  now: number,
): string | null {
  if (grant.endsAt && Date.parse(grant.endsAt) <= now) return "expired";
  if (grant.resetsLeft === 0) return "none_left";
  if (grant.startsAt && Date.parse(grant.startsAt) > now) return "not_started";
  if (grant.paused) return "paused";
  if (grant.usableNow) return null;
  if (grant.unavailableReason) return grant.unavailableReason;
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return "cooldown";
  for (const limit of grant.blocking) {
    if (limit === "five_hour") return "blocked_five_hour";
    if (limit === "seven_day") return "blocked_seven_day";
    if (limit === "seven_day_opus") return "blocked_opus";
    if (limit === "seven_day_sonnet") return "blocked_sonnet";
  }
  if (grant.blocking.length > 0) return "blocked_other";
  if (
    status.atLimit &&
    !status.exhausted.some(
      (limit) => grant.clears.includes(limit) || (limit === "seven_day" && grant.givesBackWeekly),
    )
  )
    return "cannot_clear";
  return grant.useRequiresLimit ? "needs_limit" : "unavailable";
}

/** A blocked reason as a short sentence. */
export function claudeGrantBlockedText(
  reason: string,
  grant: ClaudeLimitResetGrant,
  status: Pick<ClaudeLimitResets, "cooldownUntil">,
  now: number,
): string {
  const at = (value: string) => formatAbsoluteTime(value, { now });
  switch (reason) {
    case "expired":
      return "Expired.";
    case "none_left":
      return "Used.";
    case "not_started":
      return grant.startsAt ? `Usable from ${at(grant.startsAt)}.` : "Not usable yet.";
    case "paused":
      return "Paused by Claude.";
    case "cooldown":
      return status.cooldownUntil
        ? `Claude allows the next reset ${at(status.cooldownUntil)}.`
        : "Claude allows another reset after a short wait.";
    case "blocked_five_hour":
      return "Not usable while the 5-hour limit is reached.";
    case "blocked_seven_day":
      return grant.givesBackWeekly
        ? "No Fable usage this week to give back."
        : "Not usable while the weekly limit is reached.";
    case "blocked_opus":
      return "Not usable while the Opus weekly limit is reached.";
    case "blocked_sonnet":
      return "Not usable while the Sonnet weekly limit is reached.";
    case "blocked_other":
      return "Not usable while another limit is reached.";
    case "cannot_clear":
      return "Doesn't clear the limit that's reached now.";
    case "needs_limit":
      return "Usable once a limit it clears is reached.";
    default:
      return "Claude says it can't be used right now.";
  }
}

/** The grants worth listing: usable first, then the soonest to expire. */
export function claudeListedGrants(
  status: ClaudeLimitResets,
  now: number,
): Array<{ grant: ClaudeLimitResetGrant; blocked: string | null }> {
  const expiry = (grant: ClaudeLimitResetGrant) =>
    grant.endsAt ? Date.parse(grant.endsAt) : Number.POSITIVE_INFINITY;
  return status.grants
    .map((grant) => ({ grant, blocked: claudeGrantBlockedReason(grant, status, now) }))
    .sort(
      (left, right) =>
        Number(left.blocked !== null) - Number(right.blocked !== null) ||
        expiry(left.grant) - expiry(right.grant),
    );
}

function resetsLeftText(grant: ClaudeLimitResetGrant): string | null {
  if (grant.resetsLeft === null) return null;
  if (grant.resetsTotal !== null && grant.resetsTotal > 1)
    return `${grant.resetsLeft} of ${grant.resetsTotal} left`;
  return grant.resetsLeft === 1 ? "1 left" : `${grant.resetsLeft} left`;
}

/**
 * The account's limit resets, as a section of its page. Nothing when Claude
 * offers this account none (or hasn't been asked yet).
 */
export function ClaudeLimitResetsSection({
  usage,
  renderAction,
}: {
  usage: ClaudeSubscriptionUsage | null;
  /** A control for one grant (claiming it), when the viewer may use resets. */
  renderAction?: ((grant: ClaudeLimitResetGrant, blocked: string | null) => ReactNode) | undefined;
}) {
  const now = useMinuteNow();
  const status = usage?.limitResets;
  if (!status || status.grants.length === 0) return null;
  const grants = claudeListedGrants(status, now);
  return (
    <DetailSection
      title="Limit resets"
      description="Claude gives this account resets that clear a reached limit right away."
    >
      <SettingRowGroup role="list" aria-label="Limit resets" className="-mb-3">
        {grants.map(({ grant, blocked }) => {
          const facts = [
            resetsLeftText(grant),
            grant.endsAt ? `Expires ${formatAbsoluteTime(grant.endsAt, { now })}` : null,
          ].filter(Boolean);
          const state =
            blocked === null ? "Usable now." : claudeGrantBlockedText(blocked, grant, status, now);
          return (
            <SettingRow
              key={grant.id}
              role="listitem"
              data-grant={grant.id}
              label={claudeGrantTitle(grant)}
              description={
                <span className="flex flex-col gap-0.5">
                  {claudeGrantClears(grant) ? <span>{claudeGrantClears(grant)}</span> : null}
                  {facts.length ? <span>{facts.join(" · ")}</span> : null}
                  <span
                    data-slot="grant-state"
                    className={blocked === null ? "text-status-idle" : undefined}
                  >
                    {state}
                  </span>
                </span>
              }
              control={renderAction?.(grant, blocked)}
            />
          );
        })}
      </SettingRowGroup>
    </DetailSection>
  );
}
