import type {
  ManagedAuthDeepLinkResolution,
  ManagedAuthSessionSetProjection,
} from "@opengeni/sdk/accounts";
import { useEffect, useRef, useSyncExternalStore } from "react";

export type BrowserAccountBridgeBlocker = {
  id: string;
  label: string;
  detail?: string | undefined;
};

export type BrowserAccountBridgeOperations = {
  resolveDeepLink: (path: string) => Promise<ManagedAuthDeepLinkResolution>;
  selectSlot: (slotId: string) => Promise<boolean>;
};

export type BrowserAccountSafeSlot = ManagedAuthSessionSetProjection["slots"][number];
export type BrowserAccountBridgeBlockerInspector = () => BrowserAccountBridgeBlocker | null;

type BlockerRegistration = {
  id: string;
  inspect: BrowserAccountBridgeBlockerInspector;
};

const blockerRegistrations = new Map<string, BrowserAccountBridgeBlockerInspector>();
const blockerListeners = new Set<() => void>();
let blockerSnapshot: BlockerRegistration[] = [];
const operationListeners = new Set<() => void>();
let operations: BrowserAccountBridgeOperations | null = null;

function publishBlockers(): void {
  blockerSnapshot = [...blockerRegistrations.entries()]
    .map(([id, inspect]) => ({ id, inspect }))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const listener of blockerListeners) listener();
}

export function subscribeBrowserAccountBridgeBlockers(listener: () => void): () => void {
  blockerListeners.add(listener);
  return () => blockerListeners.delete(listener);
}

export function browserAccountBridgeBlockersSnapshot(): BlockerRegistration[] {
  return blockerSnapshot;
}

export function installBrowserAccountBridgeOperations(
  next: BrowserAccountBridgeOperations,
): () => void {
  operations = next;
  for (const listener of operationListeners) listener();
  return () => {
    if (operations !== next) return;
    operations = null;
    for (const listener of operationListeners) listener();
  };
}

function subscribeBrowserAccountBridgeOperations(listener: () => void): () => void {
  operationListeners.add(listener);
  return () => operationListeners.delete(listener);
}

function browserAccountBridgeOperationsSnapshot(): BrowserAccountBridgeOperations | null {
  return operations;
}

export function useOptionalBrowserAccountBridge(): BrowserAccountBridgeOperations | null {
  return useSyncExternalStore(
    subscribeBrowserAccountBridgeOperations,
    browserAccountBridgeOperationsSnapshot,
    browserAccountBridgeOperationsSnapshot,
  );
}

export function useBrowserAccountBridgeBlocker(
  id: string,
  inspect: BrowserAccountBridgeBlockerInspector,
): void {
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;
  useEffect(() => {
    if (!id.trim()) throw new Error("Browser account transition blocker id is required");
    const registered = () => inspectRef.current();
    blockerRegistrations.set(id, registered);
    publishBlockers();
    return () => {
      if (blockerRegistrations.get(id) === registered) {
        blockerRegistrations.delete(id);
        publishBlockers();
      }
    };
  }, [id]);
}
