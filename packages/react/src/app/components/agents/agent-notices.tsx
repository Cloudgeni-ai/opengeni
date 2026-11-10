/**
 * One-time notes about agents (bot templates and Slack agents became agents),
 * hidden for good once the reader dismisses them in this browser.
 */
import { useCallback, useMemo, useState } from "react";

const PREFIX = "opengeni.notice.";

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(PREFIX + key) === "dismissed";
  } catch {
    return false;
  }
}

export function useDismissedNotice(key: string): { dismissed: boolean; dismiss: () => void } {
  // Read again when the key changes (a note per organization, known later).
  const stored = useMemo(() => read(key), [key]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const dismiss = useCallback(() => {
    setDismissedKey(key);
    try {
      window.localStorage.setItem(PREFIX + key, "dismissed");
    } catch {
      // Without storage the note comes back next time; that's fine.
    }
  }, [key]);
  return { dismissed: stored || dismissedKey === key, dismiss };
}
