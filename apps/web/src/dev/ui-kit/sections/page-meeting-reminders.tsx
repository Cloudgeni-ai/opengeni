import { useState } from "react";
import type { DesktopMeetingDetectionStatus } from "@opengeni/sdk/desktop-bridge";
import { Section } from "@opengeni/react/ui/section";

import { CalendarRemindersRow } from "@/components/desktop/calendar-reminders-row";
import { CalendarRemindersNotice } from "@/components/meetings/calendar-reminders-offer";

import { KitBlock, KitCanvas, KitSection } from "../kit";

type Status = DesktopMeetingDetectionStatus & { calendarReminders: boolean };

function status(change: Partial<Status>): Status {
  return {
    available: true,
    enabled: true,
    autoRecord: false,
    calendarReminders: true,
    calendar: "connected",
    ...change,
  };
}

/** The switch with its own state, so it can be turned on and off here. */
function Row({ title, initial }: { title: string; initial: Status }) {
  const [current, setCurrent] = useState(initial);
  return (
    <Section variant="group" title={title}>
      <CalendarRemindersRow
        status={current}
        onChange={(on) => setCurrent({ ...current, calendarReminders: on })}
        onConnectCalendar={() => undefined}
      />
    </Section>
  );
}

function Offer() {
  const [shown, setShown] = useState(true);
  return shown ? (
    <CalendarRemindersNotice onConnect={() => setShown(false)} onDismiss={() => setShown(false)} />
  ) : (
    <p className="text-xs text-fg-muted">Answered: the line doesn't show again on this computer.</p>
  );
}

export default function PageMeetingRemindersSection() {
  return (
    <KitSection sectionKey="page-meeting-reminders">
      <KitBlock
        title="Remind me before meetings"
        description="Settings → Computer use → Voice in the desktop app. With a calendar connected; without one, where the row links to connecting one; and turned off."
      >
        <KitCanvas>
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 p-6">
            <Row title="Calendar connected" initial={status({ calendar: "connected" })} />
            <Row title="No calendar" initial={status({ calendar: "none" })} />
            <Row title="Turned off" initial={status({ calendarReminders: false })} />
          </div>
        </KitCanvas>
      </KitBlock>
      <KitBlock
        title="Offer on Meetings"
        description="Once, above Meetings in the desktop app, while reminders are on and no calendar is connected. Connecting or closing it ends the offer for good."
      >
        <KitCanvas>
          <div className="mx-auto w-full max-w-[720px] p-6">
            <Offer />
          </div>
        </KitCanvas>
      </KitBlock>
    </KitSection>
  );
}
