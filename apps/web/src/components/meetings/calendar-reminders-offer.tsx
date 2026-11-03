// In the desktop app, once: a quiet line above Meetings offering to connect a
// calendar, so a minute before each meeting a card can offer to join it and
// start notes. Connecting, or closing the line, ends the offer for good on
// this computer; the switch under Computer use > Voice stays for later.
import { CalendarIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";

import { useMeetingDetection } from "../desktop/use-meeting-detection";

const SEEN_KEY = "opengeni.meetings.calendarRemindersOffer";

function offerSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "seen";
  } catch {
    return false;
  }
}

function rememberOfferSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "seen");
  } catch {
    // Storage turned off: the offer may show again, which is all it costs.
  }
}

/** Shown only in the desktop app, with reminders on and no calendar connected, until answered. */
export function CalendarRemindersOffer({
  onConnect,
  className,
}: {
  /** Opens where a calendar is connected. */
  onConnect: () => void;
  className?: string | undefined;
}) {
  const meetings = useMeetingDetection();
  const [seen, setSeen] = useState(offerSeen);
  const status = meetings.status;
  if (seen || !status || status.calendarReminders !== true || status.calendar !== "none") {
    return null;
  }
  const done = () => {
    rememberOfferSeen();
    setSeen(true);
  };
  return (
    <CalendarRemindersNotice
      className={className}
      onConnect={() => {
        done();
        onConnect();
      }}
      onDismiss={done}
    />
  );
}

/** The offer's line itself: one button to connect, and a close that ends it. */
export function CalendarRemindersNotice({
  onConnect,
  onDismiss,
  className,
}: {
  onConnect: () => void;
  onDismiss: () => void;
  className?: string | undefined;
}) {
  return (
    <Notice
      className={className}
      icon={<CalendarIcon aria-hidden="true" className="size-4 text-fg-subtle" />}
      action={
        <Button size="sm" variant="outline" onClick={onConnect}>
          Connect calendar
        </Button>
      }
      onDismiss={onDismiss}
      dismissLabel="Don't show again"
    >
      Get a reminder a minute before each meeting, with one click to join and start notes.
    </Notice>
  );
}
