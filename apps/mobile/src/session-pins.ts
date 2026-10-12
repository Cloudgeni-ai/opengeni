import {
  applySessionPinToLists,
  type PinnedSessionLists,
} from "@opengeni/react/session-list-model";
import type { OpenGeniClient, Session } from "@opengeni/sdk";
import { useNativeTimelineMessages } from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { Alert } from "react-native";

export type SessionLists = PinnedSessionLists<Session>;

export const EMPTY_SESSION_LISTS: SessionLists = { pinned: [], sessions: [] };

/**
 * Pin or unpin a chat from a list: the person's own pin, the same one the web
 * rail and the session header change. The row moves at once and the server
 * answer settles it; on failure the chat is read again, since the change may
 * have committed before the answer was lost, and the person is told only when
 * it really didn't happen.
 */
export function useSessionPinToggle(input: {
  client: Pick<OpenGeniClient, "updateSessionPin" | "getSession">;
  workspaceId: string | null;
  setLists: Dispatch<SetStateAction<SessionLists>>;
  /** Called with the lists after each change, to keep a cache in step. */
  onSettled?: (() => void) | undefined;
}) {
  const { client, workspaceId, setLists, onSettled } = input;
  const m = useNativeTimelineMessages();
  return useCallback(
    async (session: Session) => {
      if (!workspaceId) return;
      const pinned = !session.pinned;
      void Haptics.selectionAsync();
      setLists((lists) =>
        applySessionPinToLists(lists, {
          id: session.id,
          pinned,
          pinnedAt: pinned ? new Date().toISOString() : null,
          pinVersion: (session.pinVersion ?? 0) + 1,
        }),
      );
      try {
        const updated = await client.updateSessionPin(workspaceId, session.id, {
          pinned,
          ...(session.pinVersion !== undefined ? { expectedVersion: session.pinVersion } : {}),
        });
        setLists((lists) => applySessionPinToLists(lists, updated));
      } catch (caught) {
        const current = await client
          .getSession(workspaceId, session.id, { fresh: true })
          .catch(() => null);
        // The fresh read (or, offline, the row as it was) replaces the
        // optimistic revision.
        setLists((lists) =>
          applySessionPinToLists(lists, current ?? session, { authoritative: true }),
        );
        if (Boolean(current?.pinned) !== pinned) {
          const reason = caught instanceof Error ? caught.message : "";
          Alert.alert(m.pinFailed(pinned), reason || undefined);
        }
      } finally {
        onSettled?.();
      }
    },
    [client, workspaceId, setLists, onSettled, m],
  );
}
