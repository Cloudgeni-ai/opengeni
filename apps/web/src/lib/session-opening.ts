import { useState } from "react";

/** This visit's successful initialization, not a cache of previously seen IDs. */
export function useSessionOpening(identity: string, ready: boolean) {
  const [visit, setVisit] = useState({ identity, opened: false });
  const opened = visit.identity === identity && visit.opened;
  if (visit.identity !== identity || (!opened && ready)) {
    setVisit({ identity, opened: ready });
  }
  return opened || ready;
}
