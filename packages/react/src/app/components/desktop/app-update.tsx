// The desktop app's own update, as one button at the bottom of the rail. It
// appears as soon as the app finds a new version, whether or not it has
// finished downloading. One click is the only approval: a downloaded update
// restarts the app at once; otherwise the download finishes and the app
// restarts by itself.
import type { DesktopBridge, DesktopUpdateState } from "@opengeni/sdk/desktop-bridge";
import { CircleArrowUpIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/tooltip";
import { desktopCapability } from "../../lib/desktop";
import { cn } from "../../lib/utils";

const NONE: DesktopUpdateState = { kind: "none" };

/** The app's update state; always "none" outside a desktop app that updates itself. */
export function useDesktopUpdate(bridge: DesktopBridge | null): {
  state: DesktopUpdateState;
  install: () => void;
} {
  const updates = bridge?.updates ?? null;
  const [state, setState] = useState<DesktopUpdateState>(NONE);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    const unsubscribe = updates.onChange((next) => {
      if (live) setState(next);
    });
    void updates
      .state()
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [updates]);
  return {
    state,
    install: () => {
      if (!updates) return;
      // Show the progress at once; the shell confirms with its next state.
      setState((current) =>
        current.kind === "none" ? current : { ...current, restartWhenReady: true },
      );
      void updates.install().catch(() => undefined);
    },
  };
}

/** What the button says for a found update. */
export function desktopUpdateLabel(state: Exclude<DesktopUpdateState, { kind: "none" }>): {
  text: string;
  busy: boolean;
} {
  if (!state.restartWhenReady) return { text: "Update available", busy: false };
  if (state.kind === "ready") return { text: "Restarting…", busy: true };
  return {
    text: state.percent === null ? "Updating…" : `Updating… ${state.percent}%`,
    busy: true,
  };
}

export function DesktopUpdateButton(props: {
  collapsed: boolean;
  className?: string | undefined;
  /** For previews and tests; defaults to the desktop app's bridge. */
  bridge?: DesktopBridge | null;
}) {
  const bridge = props.bridge === undefined ? desktopCapability("updates") : props.bridge;
  const { state, install } = useDesktopUpdate(bridge);
  if (state.kind === "none") return null;
  const { text, busy } = desktopUpdateLabel(state);
  const productName = bridge?.productName ?? "the app";
  const hint = busy
    ? `${productName} restarts into ${state.version} when it's ready`
    : `Restart ${productName} into version ${state.version}`;
  const Icon = busy ? LoaderCircleIcon : CircleArrowUpIcon;
  const button = (
    <button
      type="button"
      data-desktop-update={state.kind}
      aria-busy={busy || undefined}
      aria-label={props.collapsed ? `${text}, ${state.version}` : undefined}
      title={props.collapsed ? undefined : hint}
      onClick={busy ? undefined : install}
      className={cn(
        "flex items-center rounded-md text-sm font-normal text-fg outline-hidden transition-colors motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        busy ? "cursor-default" : "hover:bg-hover",
        props.collapsed
          ? "size-8 justify-center pointer-coarse:size-10"
          : "h-8 w-full gap-2.5 px-2.5 pointer-coarse:h-10",
        props.className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-brand",
          busy && "animate-spin motion-reduce:animate-none",
        )}
      />
      {props.collapsed ? null : (
        <>
          <span aria-live="polite" className="min-w-0 flex-1 truncate text-left">
            {text}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-fg-muted">{state.version}</span>
        </>
      )}
    </button>
  );
  return (
    <div className={cn("px-2 pt-2", props.collapsed && "flex justify-center")}>
      {props.collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right">
            {text} · {state.version}
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </div>
  );
}
