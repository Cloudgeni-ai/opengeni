// Settings > Computer use, inside the desktop app: what Opengeni may do on
// the computer the app runs on. The Computer use switch on top turns agents'
// use of this computer on or off; under it, one row and one switch per thing
// they can do here. Each switch is enforced by the app and its agent (see the
// desktop's computer capabilities), and the system permissions a row needs
// are asked for when the person turns it on, never before, one after another
// as each is allowed (the desktop's own asking, `allowPermissions`). One the
// person hasn't allowed is a calm line naming it; the Computer use row has
// the one button for it, and the row shows Allowed once the person comes
// back. Red is only for real failures.
import type {
  DesktopComputerCapabilities,
  DesktopComputerSettings,
  DesktopMeetingDetectionStatus,
  ThisComputerPermission,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "@opengeni/sdk/desktop-bridge";
import {
  thisComputerNeedsPermissions,
  thisComputerPermissionSteps,
} from "@opengeni/sdk/this-computer";
import { OPENGENI_BROWSER_EXTENSION_URL } from "@opengeni/contracts";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowLink } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { useAppContext } from "@opengeni/react/app/app-context";
import { desktopBridge, desktopCapability } from "@opengeni/react/app/lib/desktop";
import { useDesktopThisComputer } from "@opengeni/react/app/components/desktop/this-computer";
import { ComputerUseRow } from "@opengeni/react/app/components/desktop/computer-use";
import { EXCEL_ADDIN_PATH } from "@/lib/excel-addin";

/** What each screen-control permission is for, in a few words. */
const SCREEN_PERMISSION_ROWS: Record<
  Exclude<ThisComputerPermissionId, "files">,
  { label: string; description: string }
> = {
  screenRecording: { label: "Screen Recording", description: "To see the screen." },
  accessibility: { label: "Accessibility", description: "To click and type in apps." },
  inputMonitoring: { label: "Input Monitoring", description: "To use keyboard shortcuts." },
};

/** Where this computer stands for the Control the screen row. */
export type ScreenControlView =
  /** Computer use is off (never set up, turned off, or removed): nothing under it applies. */
  | { kind: "computerUseOff" }
  /** A separately installed agent service or an older agent runs it; the app can't switch it. */
  | { kind: "managedElsewhere" }
  | { kind: "off" }
  /** On; `permissions` are the system's, in the order to allow them (macOS only). */
  | { kind: "on"; permissions: ThisComputerPermission[] };

export function screenControlView(
  status: ThisComputerStatus | null,
  capabilities: DesktopComputerCapabilities | null,
): ScreenControlView {
  if (!status || status.state !== "connected") return { kind: "computerUseOff" };
  if (status.management === "service" || capabilities?.unavailable.includes("screenControl")) {
    return { kind: "managedElsewhere" };
  }
  if (
    capabilities &&
    (!capabilities.settings.screenControl || !capabilities.screenControlConnected)
  )
    return { kind: "off" };
  return {
    kind: "on",
    permissions: (status.permissions ?? []).filter((permission) => permission.id !== "files"),
  };
}

/** Whether agents may read Desktop, Documents and Downloads; null where nothing asks. */
export function foldersAllowed(status: ThisComputerStatus | null): boolean | null {
  if (!status || status.state !== "connected") return null;
  const files = status.permissions?.find((permission) => permission.id === "files");
  if (files) return files.granted;
  return typeof status.folders === "boolean" ? status.folders : null;
}

/**
 * The switch shows what is in effect. Where the app can't switch it (a
 * service, or an agent too old for the switch), that is whether the
 * connection has screen control.
 */
export function screenControlInEffect(
  view: ScreenControlView,
  capabilities: DesktopComputerCapabilities | null,
): boolean {
  if (view.kind === "on") return true;
  if (view.kind === "managedElsewhere") return capabilities?.screenControlConnected ?? false;
  return false;
}

/**
 * The screen permissions still missing, as the steps the person walks
 * through: Input Monitoring only once Accessibility is allowed, as macOS
 * often grants it along with Accessibility.
 */
export function missingScreenPermissions(
  status: ThisComputerStatus | null,
): ThisComputerPermission[] {
  return thisComputerPermissionSteps(status).filter(
    (permission) => permission.id !== "files" && !permission.granted,
  );
}

/** The missing screen permissions by the names System Settings lists them under: "A, B and C". */
export function missingPermissionNames(permissions: ThisComputerPermission[]): string {
  const names = permissions.flatMap((permission) =>
    permission.granted || permission.id === "files"
      ? []
      : [SCREEN_PERMISSION_ROWS[permission.id].label],
  );
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Whether the folders row has its own Allow. Not while the Computer use row
 * offers the fix: that one asks for every missing permission in turn,
 * including the folders, and two buttons for one thing is one too many.
 */
export function foldersHaveOwnAction(status: ThisComputerStatus | null): boolean {
  return !thisComputerNeedsPermissions(status);
}

const COMPUTER_USE_OFF = "Turn on Computer use first.";
const MANAGED_ELSEWHERE = "Set in the Opengeni Agent service on this computer.";
const UPDATE_THE_APP = "Update the Opengeni app to change this.";

function Allowed() {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
      <CheckIcon className="size-4 text-success" aria-hidden />
      Allowed
    </span>
  );
}

/** A system permission: Allowed, the one button that gets it, or a calm line when another row has it. */
function PermissionRow({
  label,
  description,
  granted,
  action,
  onAction,
  disabledReason,
}: {
  label: string;
  description: ReactNode;
  granted: boolean;
  action: string | null;
  onAction?: (() => void) | undefined;
  disabledReason?: string | undefined;
}) {
  return (
    <SettingRow
      label={label}
      description={
        disabledReason ?? (!granted && action === null ? "Not allowed yet." : description)
      }
      control={
        granted ? (
          <Allowed />
        ) : action === null ? undefined : (
          <Button size="sm" variant="outline" disabled={Boolean(disabledReason)} onClick={onAction}>
            {action}
          </Button>
        )
      }
    />
  );
}

type RowErrors = Partial<Record<keyof DesktopComputerSettings, string>>;

/** The desktop's switches, kept current while the page is open. */
function useComputerCapabilities() {
  const bridge = desktopCapability("computerCapabilities")?.computerCapabilities ?? null;
  const [capabilities, setCapabilities] = useState<DesktopComputerCapabilities | null>(null);
  const [saving, setSaving] = useState<keyof DesktopComputerSettings | null>(null);
  // Failures of the page's own calls, per row; the app's own come in `problems`.
  const [failed, setFailed] = useState<RowErrors>({});

  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge
      .status()
      .then(setCapabilities)
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    refresh();
    const off = bridge.onChange(refresh);
    // Permissions are changed in the system's settings, outside the app.
    window.addEventListener("focus", refresh);
    return () => {
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, refresh]);

  const run = useCallback(
    async (
      key: keyof DesktopComputerSettings,
      call: () => Promise<DesktopComputerCapabilities>,
    ) => {
      setSaving(key);
      setFailed((current) => ({ ...current, [key]: undefined }));
      try {
        const next = await call();
        setCapabilities(next);
        return next;
      } catch {
        setFailed((current) => ({ ...current, [key]: "Couldn't save the change. Try again." }));
        return null;
      } finally {
        setSaving(null);
      }
    },
    [],
  );

  const update = useCallback(
    (key: keyof DesktopComputerSettings, on: boolean) =>
      bridge ? run(key, () => bridge.update({ [key]: on })) : Promise.resolve(null),
    [bridge, run],
  );

  const requestMicrophone = useCallback(
    () => (bridge ? run("microphone", () => bridge.requestMicrophone()) : Promise.resolve(null)),
    [bridge, run],
  );

  const errorFor = (key: keyof DesktopComputerSettings): string | undefined =>
    failed[key] ?? capabilities?.problems?.[key];

  return { bridge, capabilities, saving, errorFor, update, requestMicrophone, refresh };
}

/** Whether the Opengeni Browser extension in Chrome reaches this computer now. */
function useChromeOnThisComputer(
  workspaceId: string,
  enrollmentId: string | undefined,
): { name: string } | null {
  const { client } = useAppContext();
  const [connected, setConnected] = useState<{ name: string } | null>(null);
  useEffect(() => {
    if (!enrollmentId) {
      setConnected(null);
      return;
    }
    let cancelled = false;
    const read = () => {
      client
        .listAttachedBrowsers(workspaceId)
        .then((result) => {
          if (cancelled) return;
          const device = result.devices.find(
            (candidate) =>
              candidate.state === "connected" && candidate.enrollmentId === enrollmentId,
          );
          setConnected(device ? { name: device.profileLabel ?? device.browserName } : null);
        })
        // Without inventory access the row still offers the extension.
        .catch(() => undefined);
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [client, enrollmentId, workspaceId]);
  return connected;
}

/** The latest status straight from the app, not the copy the page last saw. */
async function freshStatus(workspaceId: string): Promise<ThisComputerStatus | null> {
  const bridge = desktopCapability("thisComputer")?.thisComputer;
  if (!bridge) return null;
  return bridge.status(workspaceId).catch(() => null);
}

/** Computer use on this computer: the switch for it, then what agents may do here. */
export function ThisComputerAgentSettings({ className }: { className?: string }) {
  const desktop = useDesktopThisComputer();
  const caps = useComputerCapabilities();
  const status = desktop?.computer.status ?? null;
  const chrome = useChromeOnThisComputer(desktop?.workspaceId ?? "", status?.enrollmentId);
  const [turningOn, setTurningOn] = useState(false);
  // Which switches apply follows the computer's state (another agent serving
  // it, a connection made without the screen): read them again when it changes.
  const refreshCapabilities = caps.refresh;
  useEffect(() => {
    if (status) refreshCapabilities();
  }, [status, refreshCapabilities]);
  if (!desktop || !status || status.state === "unavailable") return null;
  const { computer, platform, workspaceId } = desktop;
  const view = screenControlView(status, caps.capabilities);
  const folders = foldersAllowed(status);
  // The app's switches are still being read: the switches wait, nothing to explain yet.
  const loading = caps.bridge !== null && caps.capabilities === null;

  const reason =
    view.kind === "computerUseOff"
      ? COMPUTER_USE_OFF
      : view.kind === "managedElsewhere"
        ? (caps.capabilities?.problems?.screenControl ?? MANAGED_ELSEWHERE)
        : caps.bridge
          ? undefined
          : UPDATE_THE_APP;
  const chromeReason =
    view.kind === "computerUseOff"
      ? COMPUTER_USE_OFF
      : status.management === "service" ||
          caps.capabilities?.unavailable.includes("browserExtension")
        ? (caps.capabilities?.problems?.browserExtension ?? MANAGED_ELSEWHERE)
        : caps.bridge
          ? undefined
          : UPDATE_THE_APP;

  const setScreenControl = async (on: boolean) => {
    const next = await caps.update("screenControl", on);
    if (!on || !next) return;
    setTurningOn(true);
    try {
      // A connection made without screen control is made again with it.
      if (!next.screenControlConnected) await computer.connect({ screenControl: true });
      // The agent just restarted with the screen: ask for what macOS is
      // missing in the same step, from what it says now.
      computer.allowPermissions(await freshStatus(workspaceId));
    } finally {
      setTurningOn(false);
      caps.refresh();
    }
  };

  const browserOn = caps.capabilities?.settings.browserExtension ?? true;
  const screenError = caps.saving === "screenControl" ? undefined : caps.errorFor("screenControl");
  const screenMissing = view.kind === "on" ? missingScreenPermissions(status) : [];
  const firstMissing = screenMissing[0];

  return (
    <Section variant="group" className={className}>
      <ComputerUseRow desktop={desktop} />
      <SettingRow
        label="Control the screen"
        description={
          view.kind === "on"
            ? firstMissing
              ? "On once macOS allows it."
              : "Agents can see the screen and use apps."
            : view.kind === "off"
              ? "Off. Agents can't see the screen or use apps."
              : reason
        }
        error={view.kind === "managedElsewhere" ? undefined : screenError}
        control={
          <Switch
            checked={loading ? false : screenControlInEffect(view, caps.capabilities)}
            pending={loading || caps.saving === "screenControl" || turningOn}
            disabled={reason !== undefined}
            {...(reason ? { disabledReason: reason } : {})}
            onCheckedChange={(on) => void setScreenControl(on)}
          />
        }
      >
        {view.kind !== "on" ? null : firstMissing ? (
          // Not an error: a calm line naming what's missing. The Computer use
          // row above has the one Open System Settings for it, which asks for
          // these in turn.
          <SettingRow
            label={missingPermissionNames(screenMissing)}
            description="Not allowed yet."
          />
        ) : (
          view.permissions.map((permission) => {
            const row =
              SCREEN_PERMISSION_ROWS[permission.id as keyof typeof SCREEN_PERMISSION_ROWS];
            return (
              <SettingRow
                key={permission.id}
                label={row.label}
                description={row.description}
                control={<Allowed />}
              />
            );
          })
        )}
      </SettingRow>
      <SettingRow
        label="Google Chrome"
        description={
          chromeReason ??
          (!browserOn
            ? "Off. The Opengeni Browser extension can't reach this computer."
            : chrome
              ? `Browser extension connected · ${chrome.name}`
              : "Agents can use your Chrome with the Opengeni Browser extension.")
        }
        // Without the extension the switch does nothing yet, so the row says where to get it.
        hint={
          !chromeReason && browserOn && !chrome ? (
            <SettingRowLink
              onClick={() => void desktopBridge?.openExternal(OPENGENI_BROWSER_EXTENSION_URL)}
            >
              Get the extension
            </SettingRowLink>
          ) : undefined
        }
        error={
          chromeReason || caps.saving === "browserExtension"
            ? undefined
            : caps.errorFor("browserExtension")
        }
        control={
          <Switch
            checked={!chromeReason && !loading && browserOn}
            pending={loading || caps.saving === "browserExtension"}
            disabled={chromeReason !== undefined}
            {...(chromeReason ? { disabledReason: chromeReason } : {})}
            onCheckedChange={(on) => void caps.update("browserExtension", on)}
          />
        }
      />
      {/* Only macOS guards these folders. */}
      {platform === "macos" && (folders !== null || view.kind === "computerUseOff") ? (
        <PermissionRow
          label="Desktop, Documents and Downloads"
          description="To open your files in these folders."
          granted={folders === true}
          action={foldersHaveOwnAction(status) ? "Allow" : null}
          onAction={() => void computer.requestPermission("files")}
          disabledReason={view.kind === "computerUseOff" ? COMPUTER_USE_OFF : undefined}
        />
      ) : null}
      <SettingRow
        label="Microsoft Excel"
        description="Agents can work in your workbooks with the Opengeni add-in."
        control={
          <Button size="sm" variant="outline" asChild>
            {/* A public page about adding the add-in, opened like the account menu's link. */}
            <a href={EXCEL_ADDIN_PATH} target="_blank" rel="noopener noreferrer">
              Set up
            </a>
          </Button>
        }
      />
    </Section>
  );
}

/** Whether the app offers to record when a call starts, kept current while the page is open. */
function useMeetingDetection() {
  const bridge = desktopCapability("meetingDetection")?.meetingDetection ?? null;
  const [status, setStatus] = useState<DesktopMeetingDetectionStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge
      .status()
      .then(setStatus)
      .catch(() => undefined);
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    refresh();
    return bridge.onChange(refresh);
  }, [bridge, refresh]);
  const update = useCallback(
    async (enabled: boolean) => {
      if (!bridge) return;
      setSaving(true);
      setFailed(null);
      try {
        setStatus(await bridge.update({ enabled }));
      } catch {
        setFailed("Couldn't save the change. Try again.");
      } finally {
        setSaving(false);
      }
    },
    [bridge],
  );
  return { bridge, status, saving, failed, update };
}

/** The app's own use of the microphone, for dictation, voice chats and meeting recordings. */
export function ThisComputerMicrophoneSettings({ className }: { className?: string }) {
  const caps = useComputerCapabilities();
  const meetings = useMeetingDetection();
  const platform = desktopBridge?.platform ?? "macos";
  if (!caps.bridge || !caps.capabilities) return null;
  const on = caps.capabilities.settings.microphone;
  const permission = caps.capabilities.microphone;
  const pending = caps.saving === "microphone";
  const detection = meetings.status;
  return (
    <Section variant="group" title="Voice" className={className}>
      <SettingRow
        label="Microphone"
        description={
          on
            ? "For dictation, voice chats and meeting recordings."
            : // A recording already running keeps its microphone until it stops.
              "Off. Dictation, voice chats and new recordings can't use the microphone."
        }
        error={pending ? undefined : caps.errorFor("microphone")}
        control={
          <Switch
            checked={on}
            pending={pending}
            onCheckedChange={(next) =>
              void (next ? caps.requestMicrophone() : caps.update("microphone", false))
            }
          />
        }
      >
        {on && permission !== "unknown" ? (
          <PermissionRow
            label="Microphone access"
            description={
              permission === "denied"
                ? `Turned off in ${platform === "macos" ? "System Settings" : "Windows privacy settings"}.`
                : permission === "granted"
                  ? undefined
                  : "Asked the first time you dictate."
            }
            granted={permission === "granted"}
            action={
              permission === "denied" && platform === "macos" ? "Open System Settings" : "Allow"
            }
            onAction={() => void caps.requestMicrophone()}
          />
        ) : null}
      </SettingRow>
      {meetings.bridge && detection?.available ? (
        <SettingRow
          label="Offer to record calls"
          description={
            detection.enabled
              ? "When Zoom, Teams, Slack, or a meeting in your browser starts using the microphone, a notification asks whether to record it."
              : "Off. Start meeting recordings yourself from Meetings."
          }
          error={meetings.saving ? undefined : (meetings.failed ?? detection.problem)}
          control={
            <Switch
              checked={detection.enabled}
              pending={meetings.saving}
              onCheckedChange={(next) => void meetings.update(next)}
            />
          }
        />
      ) : null}
    </Section>
  );
}
