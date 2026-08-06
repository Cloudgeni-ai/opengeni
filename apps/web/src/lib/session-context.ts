import type { Session } from "@/types";

type EffectiveControl = Session["effectiveControl"];
type EffectiveControlBlocker = NonNullable<EffectiveControl["primaryBlocker"]>;
type EffectiveControlResumeOption = EffectiveControl["resumeOptions"][number];

function sameBlocker(
  a: EffectiveControlBlocker | null | undefined,
  b: EffectiveControlBlocker | null | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.kind === b.kind &&
    Object.is(a.sessionId, b.sessionId) &&
    a.displayName === b.displayName &&
    Object.is(a.actor, b.actor) &&
    Object.is(a.reason, b.reason) &&
    Object.is(a.changedAt, b.changedAt) &&
    a.revision === b.revision
  );
}

function sameResumeOption(
  a: EffectiveControlResumeOption,
  b: EffectiveControlResumeOption,
): boolean {
  return (
    a.scope === b.scope &&
    Object.is(a.targetId, b.targetId) &&
    a.selectedStateAfter === b.selectedStateAfter &&
    sameBlocker(a.remainingPrimaryBlocker, b.remainingPrimaryBlocker) &&
    a.impactCopy === b.impactCopy
  );
}

function sameEffectiveControl(a: EffectiveControl, b: EffectiveControl): boolean {
  if (a === b) {
    return true;
  }
  if (
    a.state !== b.state ||
    a.controlVersion !== b.controlVersion ||
    a.controlEtag !== b.controlEtag ||
    a.directState !== b.directState ||
    a.additionalBlockerCount !== b.additionalBlockerCount ||
    !sameBlocker(a.primaryBlocker, b.primaryBlocker) ||
    a.blockers.length !== b.blockers.length ||
    a.resumeOptions.length !== b.resumeOptions.length
  ) {
    return false;
  }
  if (!a.blockers.every((blocker, index) => sameBlocker(blocker, b.blockers[index]))) {
    return false;
  }
  for (const [index, option] of a.resumeOptions.entries()) {
    const other = b.resumeOptions[index];
    if (!other || !sameResumeOption(option, other)) {
      return false;
    }
  }
  if (a.override !== b.override) {
    if (!a.override || !b.override) {
      return false;
    }
    if (
      a.override.rootSessionId !== b.override.rootSessionId ||
      a.override.revision !== b.override.revision
    ) {
      return false;
    }
  }
  if (a.settlement !== b.settlement) {
    if (!a.settlement || !b.settlement) {
      return false;
    }
    if (
      a.settlement.state !== b.settlement.state ||
      a.settlement.attemptCount !== b.settlement.attemptCount ||
      a.settlement.interruptionPendingCount !== b.settlement.interruptionPendingCount ||
      a.settlement.quiescencePendingCount !== b.settlement.quiescencePendingCount
    ) {
      return false;
    }
  }
  return true;
}

export function sameSessionForContext(a: Session | null, b: Session | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const aKeys = Object.keys(a) as Array<keyof Session>;
  const bKeys = Object.keys(b) as Array<keyof Session>;
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    if (key === "effectiveControl") {
      if (!sameEffectiveControl(a.effectiveControl, b.effectiveControl)) {
        return false;
      }
      continue;
    }
    if (!Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}
