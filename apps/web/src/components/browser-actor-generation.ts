import type { BrowserAccountTransition } from "@opengeni/react/accounts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Counts browser-account actor changes. Key a subtree that must outlive the
 * browser-accounts loading gate (the meeting recorder) on the count:
 * re-signing in or adding an account reloads the same person without an actor
 * change and keeps it, while another account or a sign-out remounts it before
 * the new actor loads.
 *
 * The returned callback is stable: the accounts provider restarts its startup
 * refresh whenever its transition callback changes.
 */
export function useBrowserActorGeneration(
  onActorTransition: (transition: BrowserAccountTransition) => Promise<void>,
): [number, (transition: BrowserAccountTransition) => Promise<void>] {
  const [generation, setGeneration] = useState(0);
  const latest = useRef(onActorTransition);
  useLayoutEffect(() => {
    latest.current = onActorTransition;
  });
  const handleActorTransition = useCallback(async (transition: BrowserAccountTransition) => {
    flushSync(() => setGeneration((value) => value + 1));
    await latest.current(transition);
  }, []);
  return [generation, handleActorTransition];
}
