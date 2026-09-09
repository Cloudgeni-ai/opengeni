import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { selectedAvailableCapabilityToolIds } from "./session-tools";

/** Reconcile a draft against live providers without treating catalog changes as policy changes. */
export function useCapabilityToolDefaults(input: {
  ready: boolean;
  workspaceId: string | null;
  configuredIds?: string[];
  principalKey: string;
  availableIds: string[];
  defaultIds: string[];
  appliedKey: RefObject<string | null>;
  seenIds: RefObject<Set<string>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const { ready, workspaceId, configuredIds, appliedKey, seenIds, setSelected } = input;
  const excludedIds = useRef(new Set<string>());
  const policyKey = JSON.stringify([
    workspaceId,
    input.principalKey,
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
      excludedIds.current = new Set();
      setSelected(new Set(defaultIds));
      seenIds.current = new Set(availableIds);
      return;
    }
    const previouslyAvailable = seenIds.current;
    const excluded = excludedIds.current;
    setSelected((current) => {
      // Only absence while a provider was available is a draft opt-out.
      // Providers dropped by catalog revocation may return enabled by default.
      for (const id of previouslyAvailable) {
        if (!current.has(id)) excluded.add(id);
        else excluded.delete(id);
      }
      return selectedAvailableCapabilityToolIds(
        current,
        availableIds,
        previouslyAvailable,
        defaultIds.filter((id) => !excluded.has(id)),
      );
    });
    seenIds.current = new Set(availableIds);
  }, [ready, policyKey, availableKey, defaultsKey, appliedKey, seenIds, setSelected]);
}
