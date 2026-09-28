import { useState } from "react";

/** This visit's successful initialization, not a cache of previously seen IDs. */
export function useSessionOpening(identity: string, ready: boolean, hasEvents = false) {
  const [visit, setVisit] = useState({ identity, opened: false, hasObservedHistory: false });
  const opened = ready || (visit.identity === identity && visit.opened);
  const hasObservedHistory = hasEvents || (visit.identity === identity && visit.hasObservedHistory);
  if (
    visit.identity !== identity ||
    visit.opened !== opened ||
    visit.hasObservedHistory !== hasObservedHistory
  ) {
    setVisit({ identity, opened, hasObservedHistory });
  }
  return { opened, hasObservedHistory };
}
