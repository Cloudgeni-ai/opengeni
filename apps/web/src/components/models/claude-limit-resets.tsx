import type {
  ClaimClaudeLimitResetRequest,
  ClaimClaudeLimitResetResponse,
  ClaudeLimitResetClaim,
  ClaudeLimitResetGrant,
  ClaudeLimitResets,
  ClaudeSubscriptionUsage,
} from "@opengeni/sdk";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
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
  return claudeClearsText(grant.clears, grant.givesBackWeekly);
}

function claudeClearsText(clears: readonly string[], givesBackWeekly: boolean): string | null {
  const names = new Set<string>();
  if (givesBackWeekly) names.add("Fable");
  for (const id of clears) {
    if (id === "five_hour") names.add("5-hour");
    else if (id === "seven_day") names.add("weekly");
    else if (id === "seven_day_overage_included") names.add(givesBackWeekly ? "Fable" : "weekly");
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

/** What a claim's answer means for the person, and whether to say it as an error. */
export function claudeClaimOutcome(
  claim: ClaudeLimitResetClaim,
  grant: ClaudeLimitResetGrant,
  now: number,
): { ok: boolean; title: string; description?: string } {
  switch (claim.result) {
    case "reset": {
      const cleared = claudeClearsText(
        claim.cleared.length ? claim.cleared : grant.clears,
        grant.givesBackWeekly,
      );
      return {
        ok: true,
        title: "Limit reset used",
        description: cleared
          ? cleared.replace(/^Clears/, "Claude cleared")
          : "Claude cleared the limit.",
      };
    }
    case "already_used":
      return { ok: false, title: "This reset was already used" };
    case "not_limited":
      return {
        ok: false,
        title: "Nothing to reset",
        description: "No limit this reset clears is reached. It wasn't used.",
      };
    case "cooldown":
      return {
        ok: false,
        title: "Not yet",
        description: claim.cooldownUntil
          ? `Claude allows the next reset ${formatAbsoluteTime(claim.cooldownUntil, { now })}. It wasn't used.`
          : "Claude allows another reset after a short wait. It wasn't used.",
      };
    case "ineligible":
      return {
        ok: false,
        title: "Claude won't use this reset now",
        description: "It wasn't used.",
      };
    case "unavailable":
      return {
        ok: false,
        title: "This reset isn't available now",
        description: "It wasn't used.",
      };
    case "rate_limited":
      return {
        ok: false,
        title: "Claude is busy",
        description: "Try again in a minute. A retry can't use a second reset.",
      };
    case "auth_error":
      return claim.retryable
        ? {
            ok: false,
            title: "Couldn't reach Claude with this account",
            description: "Try again. A retry can't use a second reset.",
          }
        : {
            ok: false,
            title: "This sign-in can't use resets",
            description: "Sign in to Claude again with your browser to use them.",
          };
    default:
      return claim.retryable
        ? {
            ok: false,
            title: "Couldn't confirm the reset",
            description: "Try again. A retry can't use a second reset.",
          }
        : { ok: false, title: "Couldn't use the reset" };
  }
}

/**
 * Claiming limit resets from one account's page: the grant waiting for
 * confirmation, and one request id per grant, kept until Claude settles it,
 * so a retry after an unknown outcome can never use a second reset.
 */
export function useClaudeLimitResetClaim({
  claim,
  beginRecord,
}: {
  claim: (request: ClaimClaudeLimitResetRequest) => Promise<ClaimClaudeLimitResetResponse>;
  /** Records the usage Claude reported right after the claim. */
  beginRecord?: (() => (usage: ClaudeSubscriptionUsage) => void) | undefined;
}) {
  const [confirming, setConfirming] = useState<ClaudeLimitResetGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const requestIds = useRef(new Map<string, string>());
  const confirm = useCallback(async (): Promise<boolean> => {
    const grant = confirming;
    if (!grant) return true;
    const requestId = requestIds.current.get(grant.id) ?? crypto.randomUUID();
    requestIds.current.set(grant.id, requestId);
    setBusy(true);
    try {
      const record = beginRecord?.();
      const response = await claim({ grantId: grant.id, requestId });
      if (!response.claim.retryable) requestIds.current.delete(grant.id);
      record?.(response.usage);
      const outcome = claudeClaimOutcome(response.claim, grant, Date.now());
      (outcome.ok ? toast.success : toast.error)(
        outcome.title,
        outcome.description ? { description: outcome.description } : undefined,
      );
      return true;
    } catch (error) {
      // Sent or not, the outcome is unknown: the same request id settles it.
      toast.error("Couldn't confirm the reset", {
        description: `${userErrorText(error)} Try again. A retry can't use a second reset.`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }, [claim, confirming, beginRecord]);
  return {
    confirming,
    busy,
    begin: setConfirming,
    close: () => setConfirming(null),
    confirm,
  };
}

/** The confirm before a limit reset is used. Mount once per account page. */
export function ClaudeLimitResetDialog({
  state,
}: {
  state: ReturnType<typeof useClaudeLimitResetClaim>;
}) {
  const now = useMinuteNow();
  const grant = state.confirming;
  return (
    <ConfirmDialog
      open={grant !== null}
      onOpenChange={(open) => {
        if (!open) state.close();
      }}
      title="Use this limit reset?"
      description="Claude clears the limits it names right away. This uses up the reset and can't be undone."
      confirmLabel="Use reset"
      pendingLabel="Using reset…"
      cancelLabel="Cancel"
      cancelAutoFocus
      destructive={false}
      onConfirm={state.confirm}
    >
      {grant ? (
        <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-[10px] bg-surface-2 px-3 py-2.5 text-xs">
          <dt className="text-fg-muted">Reset</dt>
          <dd className="m-0 break-words text-fg">{claudeGrantTitle(grant)}</dd>
          {claudeGrantClears(grant) ? (
            <>
              <dt className="text-fg-muted">Clears</dt>
              <dd className="m-0 break-words text-fg">
                {claudeGrantClears(grant)!.replace(/^Clears the /, "The ")}
              </dd>
            </>
          ) : null}
          {resetsLeftText(grant) ? (
            <>
              <dt className="text-fg-muted">Left</dt>
              <dd className="m-0 text-fg">{resetsLeftText(grant)}</dd>
            </>
          ) : null}
          {grant.endsAt ? (
            <>
              <dt className="text-fg-muted">Expires</dt>
              <dd className="m-0 text-fg">{formatAbsoluteTime(grant.endsAt, { now })}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </ConfirmDialog>
  );
}

/** The row control: "Use reset" while the grant is usable now. */
export function ClaudeUseResetButton({
  grant,
  blocked,
  state,
}: {
  grant: ClaudeLimitResetGrant;
  blocked: string | null;
  state: ReturnType<typeof useClaudeLimitResetClaim>;
}) {
  if (blocked !== null) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="rounded-[10px] pointer-coarse:h-11"
      disabled={state.busy}
      aria-label={`Use ${claudeGrantTitle(grant)}`}
      onClick={() => state.begin(grant)}
    >
      Use reset
    </Button>
  );
}
