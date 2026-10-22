import type { Channel, Session } from "@opengeni/sdk";
import type { PinnedSessionLists } from "@opengeni/react/session-list-model";

/**
 * The last session lists a workspace showed, kept for the app's lifetime so
 * returning to home or the sessions list paints immediately while a quiet
 * refresh runs, instead of an empty screen and a spinner.
 */
type Lists = {
  home?: PinnedSessionLists<Session>;
  sessions?: PinnedSessionLists<Session>;
  projects?: Channel[];
};
const lists = new Map<string, Lists>();

export function cachedLists(workspaceId: string | null | undefined): Lists {
  return (workspaceId && lists.get(workspaceId)) || {};
}

export function rememberLists(workspaceId: string, patch: Lists): void {
  lists.set(workspaceId, { ...lists.get(workspaceId), ...patch });
}
