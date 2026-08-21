import type { Session } from "@/types";

export type SessionAttentionProjection = Pick<
  Session,
  "id" | "workspaceId" | "unread" | "attentionVersion" | "lastSequence"
>;

// RailShell renders exactly one desktop-or-mobile SessionList at a time.
let listener: ((projection: SessionAttentionProjection) => void) | null = null;

function isOlder(
  current: Pick<SessionAttentionProjection, "attentionVersion" | "lastSequence">,
  projected: SessionAttentionProjection,
): boolean {
  return (
    projected.attentionVersion! < current.attentionVersion! ||
    projected.lastSequence < current.lastSequence
  );
}

/**
 * Apply a same-tab attention result without allowing an older list poll to
 * resurrect a read marker. Attention revisions order explicit mutations,
 * while lastSequence orders new durable activity; either older coordinate is
 * stale. Equal coordinates let the latest mutation response replace the page
 * projection immediately. The rail calls this only after an id-keyed lookup,
 * so both arguments represent the same session.
 */
export function applySessionAttentionProjection(
  current: Session,
  projected: SessionAttentionProjection,
): Session {
  const currentVersion = current.attentionVersion!;
  const projectedVersion = projected.attentionVersion!;
  if (
    isOlder(current, projected) ||
    (current.unread === projected.unread && currentVersion === projectedVersion)
  ) {
    return current;
  }
  return { ...current, unread: projected.unread, attentionVersion: projectedVersion };
}

export function latestSessionAttentionProjection(
  current: SessionAttentionProjection | undefined,
  projected: SessionAttentionProjection,
): SessionAttentionProjection {
  return current && isOlder(current, projected) ? current : projected;
}

export function notifySessionAttentionChanged(projection: SessionAttentionProjection): void {
  listener?.(projection);
}

export function subscribeToSessionAttentionChanges(
  onChange: (projection: SessionAttentionProjection) => void,
): () => void {
  listener = onChange;
  return () => {
    if (listener === onChange) listener = null;
  };
}
