// The "Remind me before meetings" switch under Computer use > Voice: a minute
// before a calendar meeting with a video link, the desktop app's corner card
// offers to join it and start recording. Without a calendar it says what it needs,
// with one link to connect one.
import type { DesktopMeetingDetectionStatus } from "@opengeni/sdk/desktop-bridge";

import { SettingRow, SettingRowLink } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";

import { calendarRemindersDescription } from "./use-meeting-detection";

export function CalendarRemindersRow({
  status,
  saving = false,
  onChange,
  onConnectCalendar,
}: {
  status: DesktopMeetingDetectionStatus & { calendarReminders: boolean };
  saving?: boolean;
  onChange: (on: boolean) => void;
  /** Opens where a calendar is connected; without it the row doesn't offer to. */
  onConnectCalendar?: (() => void) | undefined;
}) {
  return (
    <SettingRow
      label="Remind me before meetings"
      description={calendarRemindersDescription(status)}
      hint={
        status.calendarReminders && status.calendar === "none" && onConnectCalendar ? (
          <SettingRowLink onClick={onConnectCalendar}>Connect calendar</SettingRowLink>
        ) : undefined
      }
      control={
        <Switch checked={status.calendarReminders} pending={saving} onCheckedChange={onChange} />
      }
    />
  );
}
