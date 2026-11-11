// App-shots inside the Opengeni desktop app: a shortcut captures the window
// the person is looking at (another app's) and the app hands it to this page,
// which attaches it to the composer on screen, or opens a chat to hold it.
// Nothing is sent: the person adds a sentence and sends, or removes the chip.
import {
  APP_SHOT_BROWSER_PROFILES_MAX,
  APP_SHOT_TEXT_MAX_CHARS,
  type AppShotCapture,
  type AttachedBrowserDevice,
} from "@opengeni/contracts";
import type { UseFileAttachmentsResult } from "../../../hooks/use-file-attachments";
import type { DesktopAppShot, DesktopAppShotResult } from "@opengeni/sdk/desktop-bridge";
import { useNavigate } from "../../lib/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "../../lib/toast";

import { useAppContext } from "../../app-context";
import { useDesktopThisComputer } from "./this-computer";
import { desktopCapability } from "../../lib/desktop";
import { lastSessionMemoryId, readLastSessionId } from "../../lib/last-session-memory";

/** A capture ready to attach: the screenshot file and what it shows. */
export interface AppShotDelivery {
  image: File;
  capture: AppShotCapture;
}

interface AppShotTarget {
  attach(delivery: AppShotDelivery): void;
}

// Composers that can take an app-shot, most recently mounted or focused last.
const targets: AppShotTarget[] = [];
// A capture waiting for a composer to mount (the page had none on screen).
let pending: AppShotDelivery | null = null;

function promote(target: AppShotTarget): void {
  const index = targets.indexOf(target);
  if (index >= 0) targets.splice(index, 1);
  targets.push(target);
}

/** Attach to the composer on screen; false when there is none. */
export function deliverAppShot(delivery: AppShotDelivery): boolean {
  const target = targets.at(-1);
  if (!target) {
    pending = delivery;
    return false;
  }
  pending = null;
  target.attach(delivery);
  return true;
}

/** For tests: forget registered composers and any waiting capture. */
export function resetAppShotTargetsForTest(): void {
  targets.length = 0;
  pending = null;
}

const appShotsAvailable = typeof window !== "undefined" && desktopCapability("appShots") !== null;

/**
 * Lets the composer inside `region` take app-shots. The composer the person
 * last focused (or that mounted last) receives the next one; a capture that
 * arrived while no composer was on screen lands here as soon as it mounts.
 */
export function useAppShotTarget(
  attachments: UseFileAttachmentsResult | null,
  region: RefObject<HTMLElement | null>,
): void {
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const enabled = appShotsAvailable && Boolean(attachments?.addAppShot);
  useEffect(() => {
    if (!enabled) return;
    const target: AppShotTarget = {
      attach: ({ image, capture }) => {
        attachmentsRef.current?.addAppShot?.(image, capture);
        focusComposerInput(region.current);
      },
    };
    promote(target);
    const element = region.current;
    const onFocus = () => promote(target);
    element?.addEventListener("focusin", onFocus);
    // A waiting capture attaches once this mount has settled: an upload started
    // inside the mount itself would be cut off if React mounts it again.
    const takePending = pending
      ? setTimeout(() => {
          if (!pending || targets.at(-1) !== target) return;
          const waiting = pending;
          pending = null;
          target.attach(waiting);
        }, 0)
      : undefined;
    return () => {
      clearTimeout(takePending);
      element?.removeEventListener("focusin", onFocus);
      const index = targets.indexOf(target);
      if (index >= 0) targets.splice(index, 1);
    };
  }, [enabled, region]);
}

/** Puts the caret at the end of the message box, ready to type. */
function focusComposerInput(region: HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    const input = region?.querySelector("textarea");
    if (!input || input.disabled) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

/** The capture as stored with the screenshot, within the contract's limits. */
export function appShotCaptureFrom(
  shot: DesktopAppShot,
  computer: { name: string; sandboxId?: string | undefined } | null,
  browserProfiles: readonly AppShotBrowserProfile[] = [],
): AppShotCapture {
  const text = shot.text?.trim() ? shot.text : undefined;
  const cut = text !== undefined && text.length > APP_SHOT_TEXT_MAX_CHARS;
  return {
    app: shot.app.trim().slice(0, 200) || "App",
    ...(shot.bundleId?.trim() ? { bundleId: shot.bundleId.trim().slice(0, 255) } : {}),
    title: shot.title.slice(0, 1_000),
    capturedAt: shot.capturedAt,
    platform: shot.platform,
    ...(text !== undefined ? { text: cut ? text.slice(0, APP_SHOT_TEXT_MAX_CHARS) : text } : {}),
    ...(shot.textTruncated || cut ? { textTruncated: true } : {}),
    ...(shot.window ? { window: shot.window } : {}),
    ...(computer?.name.trim()
      ? {
          computer: {
            name: computer.name.trim().slice(0, 200),
            ...(computer.sandboxId ? { sandboxId: computer.sandboxId } : {}),
          },
        }
      : {}),
    ...(shot.browser
      ? {
          browser: {
            url: shot.browser.url,
            ...(computer && shot.browser.chromium && browserProfiles.length > 0
              ? { profiles: browserProfiles.slice(0, APP_SHOT_BROWSER_PROFILES_MAX) }
              : {}),
          },
        }
      : {}),
  };
}

/** A browser profile connected through the Opengeni browser extension. */
export interface AppShotBrowserProfile {
  deviceId: string;
  name: string;
}

/**
 * The browser profiles connected to the workspace from this computer, in a
 * stable order: where a page captured in a Chromium-based browser is open.
 */
export function browserProfilesOnComputer(
  devices: readonly AttachedBrowserDevice[],
  enrollmentId: string,
): AppShotBrowserProfile[] {
  return devices
    .filter((device) => device.state === "connected" && device.enrollmentId === enrollmentId)
    .map((device) => ({
      deviceId: device.id,
      name: (device.profileLabel ?? device.name).trim().slice(0, 200) || device.browserName,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId))
    .slice(0, APP_SHOT_BROWSER_PROFILES_MAX);
}

/** "Safari - Example Domain.png": the screenshot's file name. */
export function appShotFileName(shot: Pick<DesktopAppShot, "app" | "title">): string {
  const base = [shot.app, shot.title]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" - ")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${base || "App-shot"}.png`;
}

interface ConnectedComputer {
  name: string;
  sandboxId?: string | undefined;
  /** Its connection, which browser profiles opened on it report too. */
  enrollmentId?: string | undefined;
}

/**
 * This computer as agents know it, when it is connected to the workspace:
 * its name and the machine id agents use to switch to it.
 */
function useConnectedComputer(workspaceId: string): ConnectedComputer | null {
  const context = useAppContext();
  const status = useDesktopThisComputer()?.computer.status ?? null;
  const connected = status?.state === "connected";
  const name = connected ? status.machineName : "";
  const enrollmentId = connected ? status.enrollmentId : undefined;
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  useEffect(() => {
    setSandboxId(null);
    if (!enrollmentId) return;
    let live = true;
    context.client
      .listMachines(workspaceId)
      .then((response) => {
        if (!live) return;
        const machine = response.machines.find((entry) => entry.enrollmentId === enrollmentId);
        setSandboxId(machine?.sandboxId ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [context.client, enrollmentId, workspaceId]);
  if (!connected || !name) return null;
  return {
    name,
    ...(sandboxId ? { sandboxId } : {}),
    ...(enrollmentId ? { enrollmentId } : {}),
  };
}

/**
 * Mounted once per workspace shell: receives the app's captures and attaches
 * each to the composer on screen, or opens the last chat (else a new one)
 * and attaches it there.
 */
export function AppShotCoordinator({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const computer = useConnectedComputer(workspaceId);
  const latest = useRef({ computer, navigate, context, workspaceId });
  latest.current = { computer, navigate, context, workspaceId };

  useEffect(() => {
    const bridge = desktopCapability("appShots")?.appShots;
    if (!bridge) return;
    return bridge.onCapture((result: DesktopAppShotResult) => {
      const current = latest.current;
      if (!result.ok) {
        if (result.code === "permission" && result.permission) {
          const permission = result.permission;
          toast.error(result.message, {
            action: {
              label: "Allow",
              onClick: () => void bridge.requestPermission(permission).catch(() => undefined),
            },
          });
        } else if (result.code === "no_window") {
          toast(result.message);
        } else {
          toast.error(result.message);
        }
        return;
      }
      if (current.context.clientConfig.fileUploads.enabled !== true) {
        toast.error("This server doesn't accept attachments, so the app-shot can't be added.");
        return;
      }
      const { shot } = result;
      void connectedBrowserProfiles(current, shot).then((profiles) => {
        const delivery: AppShotDelivery = {
          image: new File([new Uint8Array(shot.image)], appShotFileName(shot), {
            type: shot.mimeType,
          }),
          capture: appShotCaptureFrom(shot, current.computer, profiles),
        };
        attachOrOpenChat(current, delivery);
      });
    });
  }, []);

  return null;
}

interface CoordinatorState {
  computer: ConnectedComputer | null;
  navigate: ReturnType<typeof useNavigate>;
  context: ReturnType<typeof useAppContext>;
  workspaceId: string;
}

/**
 * For a page captured in a Chromium-based browser on this connected computer:
 * the browser profiles connected from it, where the page can be continued.
 * None when that can't be known; the capture is attached either way.
 */
async function connectedBrowserProfiles(
  current: CoordinatorState,
  shot: DesktopAppShot,
): Promise<AppShotBrowserProfile[]> {
  const enrollmentId = current.computer?.enrollmentId;
  if (!shot.browser?.chromium || !enrollmentId) return [];
  try {
    const { devices } = await current.context.client.listAttachedBrowsers(current.workspaceId);
    return browserProfilesOnComputer(devices, enrollmentId);
  } catch {
    return [];
  }
}

function attachOrOpenChat(current: CoordinatorState, delivery: AppShotDelivery): void {
  if (deliverAppShot(delivery)) return;
  // No composer on screen (e.g. settings): open the chat last open here,
  // otherwise a new one; its composer takes the waiting capture.
  const shellWorkspaceId = current.workspaceId;
  const lastSessionId = readLastSessionId(
    lastSessionMemoryId(current.context.accessContext.subjectId, shellWorkspaceId),
  );
  if (lastSessionId) {
    void current.navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId: shellWorkspaceId, sessionId: lastSessionId },
      state: { restoredSessionId: lastSessionId },
    });
  } else {
    void current.navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId: shellWorkspaceId },
    });
  }
}
