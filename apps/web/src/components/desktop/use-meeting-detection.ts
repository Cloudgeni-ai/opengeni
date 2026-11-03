// The desktop app's meeting switches as the web app shows them: noticing
// calls, recording them without asking, and reminders before calendar
// meetings. Kept current while the page is open.
import type { DesktopMeetingDetectionStatus } from "@opengeni/sdk/desktop-bridge";
import { useCallback, useEffect, useState } from "react";

import { desktopCapability } from "@opengeni/react/app/lib/desktop";

/** Whether the app offers to record when a call starts, kept current while the page is open. */
export function useMeetingDetection() {
  const bridge = desktopCapability("meetingDetection")?.meetingDetection ?? null;
  const [status, setStatus] = useState<DesktopMeetingDetectionStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge
      .status()
      .then(setStatus)
      .catch(() => undefined);
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    refresh();
    return bridge.onChange(refresh);
  }, [bridge, refresh]);
  const update = useCallback(
    async (change: { enabled?: boolean; autoRecord?: boolean; calendarReminders?: boolean }) => {
      if (!bridge) return;
      setSaving(true);
      setFailed(null);
      try {
        setStatus(await bridge.update(change));
      } catch {
        setFailed("Couldn't save the change. Try again.");
      } finally {
        setSaving(false);
      }
    },
    [bridge],
  );
  return { bridge, status, saving, failed, update };
}

/** Where a calendar is connected: the workspace's Capabilities page. */
export function connectCalendarPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins`;
}

/** The reminders switch's line: what it does, or what it needs. */
export function calendarRemindersDescription(status: DesktopMeetingDetectionStatus): string {
  if (!status.calendarReminders) return "Off.";
  return status.calendar === "none"
    ? "Connect Google Calendar or Outlook to get a reminder a minute before each meeting."
    : "A minute before a meeting with a video link, a card offers to join it and start recording.";
}
