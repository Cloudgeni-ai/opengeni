import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { selectedAvailableCapabilityToolIds } from "./session-tools";

/** Reconcile a draft against live providers without treating catalog changes as policy changes. */
export function useCapabilityToolDefaults(input: {
  ready: boolean;
  workspaceId: string | null;
  configuredIds?: string[];
  availableIds: string[];
  defaultIds: string[];
  appliedKey: RefObject<string | null>;
  seenIds: RefObject<Set<string>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const { ready, workspaceId, configuredIds, appliedKey, seenIds, setSelected } = input;
  const policyKey = JSON.stringify([
    workspaceId,
    configuredIds === undefined ? null : [...configuredIds].sort(),
  ]);
  const availableKey = JSON.stringify(input.availableIds);
  const defaultsKey = JSON.stringify(input.defaultIds);
  useEffect(() => {
    if (!ready) return;
    const availableIds: string[] = JSON.parse(availableKey);
    const defaultIds: string[] = JSON.parse(defaultsKey);
    if (appliedKey.current !== policyKey) {
      appliedKey.current = policyKey;
      setSelected(new Set(defaultIds));
      seenIds.current = new Set(availableIds);
      return;
    }
    const previouslySeen = seenIds.current;
    setSelected((current) =>
      selectedAvailableCapabilityToolIds(current, availableIds, previouslySeen, defaultIds),
    );
    // Reconnection must not erase an explicit draft deselection.
    seenIds.current = new Set([...previouslySeen, ...availableIds]);
  }, [ready, policyKey, availableKey, defaultsKey, appliedKey, seenIds, setSelected]);
}
