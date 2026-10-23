// "Computer use" inside the desktop app: one switch for whether agents can
// use the computer the person is on, and a small notice for the sidebar while
// it turns on or needs something. A missing permission or a problem has
// exactly one fix; only real failures are shown as errors.
import { CircleAlertIcon, InfoIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

import {
  computerUseNoticeText,
  computerUsePermissionText,
  computerUseProblemText,
  useComputerUse,
  type ComputerUseControl,
  type ComputerUseFix,
} from "../../../components/this-computer/computer-use";
import { useOpenGeniText, type OpenGeniText } from "../../../messages/runtime";
import { cn } from "../../../lib/cn";
import { SettingRow, SettingRowLink } from "../../../ui/setting-row";
import { StatusDot } from "../../../ui/status-dot";
import { Switch } from "../../../ui/switch";
import type { DesktopThisComputer } from "./this-computer";

export interface ComputerUseOptions {
  /**
   * What "Open System Settings" does for a missing permission. By default it
   * asks for the next missing one: its System Settings list with the app's
   * guide beside it. A permissions page can pass its own.
   */
  onAllowPermissions?: (() => void) | undefined;
}

/** The computer-use switch's state and actions for this computer in the desktop app. */
export function useDesktopComputerUseControl(
  desktop: DesktopThisComputer,
  options: ComputerUseOptions = {},
): ComputerUseControl {
  return useComputerUse(desktop.computer, {
    onAllowPermissions: options.onAllowPermissions ?? desktop.allowPermissions,
    onSignIn: desktop.signIn ?? undefined,
  });
}

function fixLabel(fix: ComputerUseFix, t: OpenGeniText, tryAgain: string): string {
  return fix === "open_settings"
    ? t("thisComputer.computerUse.openSettings")
    : fix === "sign_in"
      ? t("thisComputer.computerUse.signIn")
      : tryAgain;
}

export interface ComputerUseRowProps extends ComputerUseOptions {
  desktop: DesktopThisComputer;
  className?: string | undefined;
}

/**
 * The master switch for this computer, as a settings row: off, turning on
 * (including asking for missing permissions), on, on while a permission is
 * still missing (calm, with "Open System Settings"), or on with a problem and
 * its one fix. Off pauses the agent and keeps its registration, so turning
 * it on again is instant.
 */
export function ComputerUseRow({ desktop, onAllowPermissions, className }: ComputerUseRowProps) {
  const t = useOpenGeniText();
  const use = useDesktopComputerUseControl(desktop, { onAllowPermissions });
  const { state, fix } = use;
  if (state.kind === "hidden") return null;
  const machineName = desktop.computer.status?.machineName || "this computer";
  let description: ReactNode;
  switch (state.kind) {
    case "turning_on":
      description = (
        <span className="inline-flex items-center gap-1.5">
          <Loader2Icon aria-hidden className="size-3 shrink-0 animate-spin" />
          {t("thisComputer.computerUse.turningOn")}
          {state.progress === null ? null : ` ${Math.round(state.progress * 100)}%`}
        </span>
      );
      break;
    case "on":
      description = (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="success" size="sm" />
          {t("thisComputer.computerUse.on", { machineName })}
        </span>
      );
      break;
    case "needs_permission":
      description = computerUsePermissionText(state.appName ?? desktop.productName, t);
      break;
    case "problem":
      description = (
        <span className="flex items-start gap-1.5 text-danger">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {computerUseProblemText(state, machineName, t, desktop.labels)}
          </span>
        </span>
      );
      break;
    default:
      description = t("thisComputer.computerUse.off", { machineName });
  }
  return (
    <SettingRow
      className={className}
      data-computer-use={state.kind}
      label={t("thisComputer.computerUse.title")}
      description={<span role="status">{description}</span>}
      hint={
        fix ? (
          <SettingRowLink onClick={fix.run} disabled={desktop.computer.acting}>
            {fixLabel(fix.kind, t, desktop.labels.tryAgain)}
          </SettingRowLink>
        ) : undefined
      }
      control={<Switch checked={use.checked} pending={use.busy} onCheckedChange={use.setChecked} />}
    />
  );
}

export interface ComputerUseNoticeProps extends ComputerUseOptions {
  desktop: DesktopThisComputer;
  className?: string | undefined;
}

/**
 * For the sidebar: only while computer use turns on, waits on a permission
 * (calm, not an error) or has a problem (with the same one fix as the
 * switch). Nothing when it's on or off.
 */
export function ComputerUseNotice({
  desktop,
  onAllowPermissions,
  className,
}: ComputerUseNoticeProps) {
  const t = useOpenGeniText();
  const { state, fix } = useDesktopComputerUseControl(desktop, { onAllowPermissions });
  if (state.kind !== "turning_on" && state.kind !== "problem" && state.kind !== "needs_permission")
    return null;
  const machineName = desktop.computer.status?.machineName || "this computer";
  const detail =
    state.kind === "problem"
      ? computerUseProblemText(state, machineName, t, desktop.labels)
      : state.kind === "needs_permission"
        ? computerUsePermissionText(state.appName ?? desktop.productName, t)
        : undefined;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-[10px] border border-border bg-bg px-2.5 py-2",
        className,
      )}
      data-computer-use={state.kind}
      title={detail}
    >
      <p role="status" className="flex min-w-0 items-start gap-2 text-xs leading-4.5 text-fg">
        {state.kind === "turning_on" ? (
          <Loader2Icon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 animate-spin text-fg-muted"
          />
        ) : state.kind === "needs_permission" ? (
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
        ) : (
          <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />
        )}
        <span className="min-w-0">{computerUseNoticeText(state, t)}</span>
      </p>
      {fix ? (
        <SettingRowLink
          className="ml-5.5 self-start"
          onClick={fix.run}
          disabled={desktop.computer.acting}
        >
          {fixLabel(fix.kind, t, desktop.labels.tryAgain)}
        </SettingRowLink>
      ) : null}
    </div>
  );
}
