import { SessionEventSemanticClass, SessionEventType } from "@opengeni/contracts";

const FAMILY_LIMIT = 12;
const CLOSEST_LIMIT = 3;

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * An actionable refusal for a guessed event type: the nearest registered names
 * and the dotted family the guess belongs to, so the next call can succeed.
 * Suggestions are advisory text; the canonical registry still decides validity.
 */
export function unknownSessionEventTypeMessage(value: string): string {
  const all = SessionEventType.options as readonly string[];
  const shown = JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}...` : value);
  // Bound the comparison work; no registered type is anywhere near this long.
  const lower = value.slice(0, 128).toLowerCase();
  const closest = [...all]
    .map((type) => ({
      type,
      distance: editDistance(lower, type.toLowerCase()),
    }))
    .sort((a, b) => a.distance - b.distance || a.type.localeCompare(b.type))
    .slice(0, CLOSEST_LIMIT)
    .map((entry) => entry.type);
  const segments = lower.split(".");
  let family: { prefix: string; types: string[] } | null = null;
  for (let length = segments.length - 1; length >= 1 && !family; length -= 1) {
    const prefix = `${segments.slice(0, length).join(".")}.`;
    const types = all.filter((type) => type.toLowerCase().startsWith(prefix));
    if (types.length > 0) family = { prefix: types[0]!.slice(0, prefix.length), types };
  }
  const familyText = family
    ? ` Valid ${family.prefix}* types: ${family.types.slice(0, FAMILY_LIMIT).join(", ")}${
        family.types.length > FAMILY_LIMIT ? `, and ${family.types.length - FAMILY_LIMIT} more` : ""
      }.`
    : "";
  return `Unknown session event type ${shown}. Closest valid types: ${closest.join(", ")}.${familyText} For a family of events, includeClasses (${SessionEventSemanticClass.options.join(", ")}) avoids guessing type names.`;
}

const defined = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

/**
 * Audit selectors (mode, payloadMode, resultMode, type/class filters, latest)
 * belong to view=debug. The refusal carries the corrected debug call plus the
 * content-view call without them, because either may be what the agent meant.
 */
export function sessionEventAuditSelectorMessage(input: {
  sessionId: string;
  view: string | undefined;
  cursor: string | undefined;
  audit: Record<string, unknown>;
  position: Record<string, unknown>;
}): string {
  const audit = defined(input.audit);
  const position = defined(input.position);
  const names = Object.keys(audit).join(", ");
  const debugCall = JSON.stringify({
    sessionId: input.sessionId,
    view: "debug",
    ...audit,
    ...(audit.latest === undefined ? position : {}),
  });
  if (input.cursor !== undefined) {
    return `Audit selectors require view=debug and cannot change a conversation cursor: a nextCursor continues its own view and keeps its selectors. For an audit read drop the cursor: ${debugCall}`;
  }
  const contentCall = JSON.stringify({
    sessionId: input.sessionId,
    view: input.view,
    ...position,
    ...(audit.latest !== undefined && position.limit === undefined ? { limit: 1 } : {}),
  });
  return `Audit selectors require view=debug; view=${input.view} does not take ${names}. Call ${debugCall}, or drop them to stay in view=${input.view}: ${contentCall}`;
}
