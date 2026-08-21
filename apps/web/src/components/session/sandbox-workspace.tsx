// Thin app adapter over the embeddable `<SandboxWorkspace>` from @opengeni/react.
//
// The dock "brain" (capability negotiation, capture-backed cold reads, tab
// construction, machine chip) lives in the package now — apps/web consumes it
// through the exact public surface an external embedder uses.
// This adapter only supplies the two app-specific things the package can't know:
//   1. the sonner-backed notification sink (the package has no toast dependency);
//   2. app-injected extra tabs (Run / Debug) passed as leading/trailing tabs.
import { SandboxWorkspace, type WorkspaceNotification, type WorkspaceTab } from "@opengeni/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  readSessionDockCollapsed,
  readSessionDockNavigation,
  sessionDockLayoutStorageId,
  updateSessionDockNavigation,
  writeSessionDockCollapsed,
} from "@/lib/session-dock-preferences";
import type { SessionEvent } from "@/types";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function notify(notification: WorkspaceNotification) {
  if (notification.kind === "error") {
    toast.error(notification.message);
  } else {
    toast(notification.message);
  }
}

/**
 * The session workspace dock as apps/web mounts it: the package workbench
 * (Changes | Files | Terminal | Desktop + machine chip) with the app's Run and
 * Debug tabs injected around it, and errors routed to sonner.
 */
export function SessionWorkspace(props: {
  workspaceId: string;
  sessionId: string;
  preferenceOwnerId: string;
  events: SessionEvent[];
  primary: ReactNode;
  /** App tabs shown before the workbench tabs (e.g. Run). */
  leadingTabs?: WorkspaceTab[];
  /** App tabs shown after the workbench tabs (e.g. Debug). */
  trailingTabs?: WorkspaceTab[];
  /** The landing tab id (the app defaults to its Run tab). */
  initialTab?: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  mobileLeadingControl?: ReactNode;
  openFileRequest?: {
    path: string;
    line?: number | null;
    requestId: number;
  } | null;
}) {
  const layoutStorageId = sessionDockLayoutStorageId(props.preferenceOwnerId, props.sessionId);
  const navigation = useMemo(() => readSessionDockNavigation(layoutStorageId), [layoutStorageId]);
  const initialTab = navigation.activeTab ?? props.initialTab;
  const rememberNavigation = useCallback(
    (patch: Parameters<typeof updateSessionDockNavigation>[1]) =>
      updateSessionDockNavigation(layoutStorageId, patch),
    [layoutStorageId],
  );
  const rememberActiveTab = useCallback(
    (activeTab: string) => rememberNavigation({ activeTab }),
    [rememberNavigation],
  );
  const rememberFilePath = useCallback(
    (filePath: string | null) => rememberNavigation({ filePath }),
    [rememberNavigation],
  );
  const rememberBrowserSession = useCallback(
    (browserSessionId: string | null) => rememberNavigation({ browserSessionId }),
    [rememberNavigation],
  );
  const rememberDesktopSession = useCallback(
    (desktopSessionId: string | null) => rememberNavigation({ desktopSessionId }),
    [rememberNavigation],
  );
  const [restoredStorageId, setRestoredStorageId] = useState<string | null>(null);
  const collapsedRef = useRef(props.collapsed);
  const onCollapsedChangeRef = useRef(props.onCollapsedChange);
  collapsedRef.current = props.collapsed;
  onCollapsedChangeRef.current = props.onCollapsedChange;
  const effectiveCollapsed =
    restoredStorageId === layoutStorageId
      ? props.collapsed
      : (readSessionDockCollapsed(layoutStorageId) ?? true);

  // Restore before paint, then let the existing controlled state remain the
  // single source of truth for the header toggle and mobile overlay.
  useClientLayoutEffect(() => {
    const restored = readSessionDockCollapsed(layoutStorageId) ?? true;
    setRestoredStorageId(layoutStorageId);
    if (restored !== collapsedRef.current) {
      onCollapsedChangeRef.current(restored);
    }
  }, [layoutStorageId]);

  useEffect(() => {
    if (restoredStorageId !== layoutStorageId) return;
    writeSessionDockCollapsed(layoutStorageId, props.collapsed);
  }, [layoutStorageId, props.collapsed, restoredStorageId]);

  return (
    <SandboxWorkspace
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      events={props.events}
      primary={props.primary}
      {...(props.leadingTabs ? { leadingTabs: props.leadingTabs } : {})}
      {...(props.trailingTabs ? { trailingTabs: props.trailingTabs } : {})}
      {...(initialTab ? { initialTab } : {})}
      onActiveTabChange={rememberActiveTab}
      initialFilePath={navigation.filePath}
      onFilePathChange={rememberFilePath}
      initialBrowserSessionId={navigation.browserSessionId}
      onBrowserSessionIdChange={rememberBrowserSession}
      initialComputerSessionId={navigation.desktopSessionId}
      onComputerSessionIdChange={rememberDesktopSession}
      collapsed={effectiveCollapsed}
      onCollapsedChange={props.onCollapsedChange}
      {...(props.openFileRequest ? { openFileRequest: props.openFileRequest } : {})}
      {...(props.mobileLeadingControl ? { mobileLeadingControl: props.mobileLeadingControl } : {})}
      autoSaveId={layoutStorageId}
      browserExtensionSetupUrl="/browser-extension-setup.html"
      onNotify={notify}
    />
  );
}
