// "Computer use" inside the Opengeni desktop app: the app runs the
// connected-machine agent, and the web app shows one switch for it (see
// `./computer-use`). Turning it on asks macOS for any missing permission
// itself, with the app's floating guide beside System Settings. Outside the
// desktop app (or where the deployment doesn't offer connected machines)
// everything here renders nothing.
import {
  defaultThisComputerLabels,
  thisComputerPermissionSteps,
  useThisComputer,
  type ThisComputerHost,
  type ThisComputerLabels,
  type ThisComputerPlatform,
  type ThisComputerStatus,
  type UseThisComputerResult,
} from "../../../this-computer";
import "../../../../styles/this-computer.css";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { cn } from "../../../lib/cn";

import { useAppContext } from "../../app-context";
import { desktopBridge, desktopCapability } from "../../lib/desktop";
import {
  useComputerUse,
  type ComputerUseControl,
} from "../../../components/this-computer/computer-use";
import { ComputerUseNotice, ComputerUseRow, type ComputerUseOptions } from "./computer-use";

export interface DesktopThisComputer {
  workspaceId: string;
  computer: UseThisComputerResult;
  platform: ThisComputerPlatform;
  productName: string;
  labels: ThisComputerLabels;
  /**
   * Asks for the missing permissions, one after another (the system prompt
   * the first time, else the System Settings list with the app's guide).
   * Pass the reading an action just returned, as the shared one may lag.
   */
  allowPermissions(status?: ThisComputerStatus | null): void;
  /** Signs this account in again, when the app has to; null where it can't. */
  signIn: (() => void) | null;
}

const Context = createContext<DesktopThisComputer | null>(null);

/** This computer for the open workspace; null outside the desktop app. */
export function useDesktopThisComputer(): DesktopThisComputer | null {
  return useContext(Context);
}

/** The bridge as the shared screens' host. */
function bridgeHost(): ThisComputerHost | null {
  const bridge = desktopCapability("thisComputer");
  if (!bridge) return null;
  const computer = bridge.thisComputer;
  return {
    platform: bridge.platform,
    productName: bridge.productName,
    status: (workspaceId) => computer.status(workspaceId),
    connect: (workspaceId, options) => computer.connect(workspaceId, options),
    pause: () => computer.pause(),
    resume: () => computer.resume(),
    ...(computer.requestPermission
      ? { requestPermission: (id) => computer.requestPermission!(id) }
      : {}),
    ...(computer.disconnect
      ? { disconnect: (workspaceId) => computer.disconnect!(workspaceId) }
      : {}),
    onChange: (listener) => computer.onChange(listener),
  };
}

const host = typeof window === "undefined" ? null : bridgeHost();

/** The app's own sign-in screen (its add-account welcome), to sign in again. */
const signIn = desktopBridge?.accounts?.add
  ? () => void desktopBridge!.accounts.add().catch(() => undefined)
  : null;

/** Mounted once per workspace shell, around the rail and the pages. */
export function DesktopThisComputerProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  // Only where the deployment lets people connect their own computers.
  const { clientConfig } = useAppContext();
  const offered = clientConfig.connectedMachines !== false ? host : null;
  const computer = useThisComputer(offered, workspaceId);
  useContinueAskingAfterRelaunch(computer);
  const labels = useMemo(() => defaultThisComputerLabels(), []);
  const value = useMemo<DesktopThisComputer | null>(
    () =>
      offered
        ? {
            workspaceId,
            computer,
            platform: offered.platform,
            productName: offered.productName,
            labels,
            allowPermissions: computer.allowPermissions,
            signIn,
          }
        : null,
    [computer, labels, offered, workspaceId],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * macOS quits and reopens the app to apply some grants (Screen Recording).
 * When the app comes back with turning on unfinished, it goes on asking, once,
 * for the next missing permission, unless that one was already asked for:
 * then the person declined it, and it waits for "Open System Settings".
 */
function useContinueAskingAfterRelaunch(computer: UseThisComputerResult): void {
  const done = useRef(false);
  const status = computer.status;
  const allowPermissions = computer.allowPermissions;
  useEffect(() => {
    if (done.current || !status || status.state === "unavailable") return;
    if (status.state !== "connected" || !status.setupPending) {
      // Settled without unfinished setup: nothing to continue in this window.
      if (!status.busy) done.current = true;
      return;
    }
    done.current = true;
    const next = thisComputerPermissionSteps(status).find((step) => !step.granted);
    if (next && !status.requestedPermissions?.includes(next.id)) allowPermissions();
  }, [allowPermissions, status]);
}

/**
 * The computer-use switch's state and actions for this computer, for any page
 * in the desktop app (e.g. a permissions page around the switch); null
 * outside the desktop app.
 */
export function useDesktopComputerUse(
  options: ComputerUseOptions = {},
): (ComputerUseControl & { machineName: string }) | null {
  const desktop = useDesktopThisComputer();
  const control = useComputerUse(desktop?.computer ?? null, {
    onAllowPermissions: options.onAllowPermissions ?? desktop?.allowPermissions,
    onSignIn: desktop?.signIn ?? undefined,
  });
  if (!desktop || control.state.kind === "hidden") return null;
  return { ...control, machineName: desktop.computer.status?.machineName ?? "" };
}

/** Above the account row, only while computer use turns on or needs something. */
export function DesktopThisComputerOffer({
  className,
  ...options
}: ComputerUseOptions & { className?: string | undefined }) {
  const desktop = useDesktopThisComputer();
  if (!desktop) return null;
  return <ComputerUseNotice desktop={desktop} className={className} {...options} />;
}

/** The computer-use switch as a settings row, e.g. on a permissions page or in a dialog. */
export function DesktopComputerUseRow({
  className,
  ...options
}: ComputerUseOptions & { className?: string | undefined }) {
  const desktop = useDesktopThisComputer();
  if (!desktop) return null;
  return <ComputerUseRow desktop={desktop} className={className} {...options} />;
}

/**
 * Computer use on the Machines page: the switch in its own card, drawn like a
 * `group` Section's card. Not a Section itself: this module is in the session
 * page's eager graph (the sidebar notice), and Section's chunk is not.
 */
export function DesktopThisComputerPanel({ className }: { className?: string | undefined }) {
  const desktop = useDesktopThisComputer();
  if (!desktop || !desktop.computer.status || desktop.computer.status.state === "unavailable") {
    return null;
  }
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-surface px-5 py-1", className)}>
      <ComputerUseRow desktop={desktop} />
    </div>
  );
}

/** True when the page runs inside a desktop app at all. */
export const insideDesktopApp = desktopBridge !== null;
