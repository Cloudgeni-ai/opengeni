// Thin app adapter over the embeddable `<SandboxWorkspace>` from @opengeni/react.
//
// The dock "brain" (capability negotiation, capture-backed cold reads, tab
// construction, machine chip) lives in the package now — apps/web consumes it
// through the exact public surface an external embedder (tracked issue) uses.
// This adapter only supplies the two app-specific things the package can't know:
//   1. the sonner-backed notification sink (the package has no toast dependency);
//   2. app-injected extra tabs (Run / Debug) passed as leading/trailing tabs.
import { SandboxWorkspace, type WorkspaceNotification, type WorkspaceTab } from "@opengeni/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { SessionEvent } from "@/types";

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
}) {
  return (
    <SandboxWorkspace
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      events={props.events}
      primary={props.primary}
      {...(props.leadingTabs ? { leadingTabs: props.leadingTabs } : {})}
      {...(props.trailingTabs ? { trailingTabs: props.trailingTabs } : {})}
      {...(props.initialTab ? { initialTab: props.initialTab } : {})}
      collapsed={props.collapsed}
      onCollapsedChange={props.onCollapsedChange}
      {...(props.mobileLeadingControl ? { mobileLeadingControl: props.mobileLeadingControl } : {})}
      autoSaveId="og.session.dock"
      onNotify={notify}
    />
  );
}
