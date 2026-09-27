import { useEffect, useRef, type ReactNode } from "react";
import { CirclePauseIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Notice } from "@/components/ui/notice";
import { formatAbsoluteTime, formatRelativeTime } from "@/components/ui/relative-time";
import { showUndoToast } from "@/components/ui/destructive-confirm";

import { KIT_NOW, KIT_TIME_ZONE } from "../../fixtures";
import { ADMIN_ONLY_REASON } from "./data";
import type { SettingsFrameProps } from "./settings-frame";
import { useSettingsPreview, type PauseState } from "./state";

/* ----------------------------------------------------------------------------
   Time words, pinned to the kit clock.
   -------------------------------------------------------------------------- */

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE };

/** "Today, 14:18". */
export function absoluteTime(iso: string): string {
  return formatAbsoluteTime(iso, TIME);
}

/** "In 30 min", "Tomorrow", "3 weeks ago". */
export function relativeTime(iso: string): string {
  return formatRelativeTime(iso, TIME);
}

/**
 * A time inside a sentence: "14:18 today", "08:00 tomorrow", "Mon 28 Sep, 08:00".
 * The absolute format leads with "Today, " for a label; mid-sentence it reads
 * better after the time and in lower case.
 */
export function timeInSentence(iso: string): string {
  const absolute = absoluteTime(iso);
  const match = /^(Today|Tomorrow), (.+)$/.exec(absolute);
  return match ? `${match[2]} ${match[1]!.toLowerCase()}` : absolute;
}

/** "until 14:18 today (in 30 min)" or "until someone resumes it". */
export function pauseUntilPhrase(pause: PauseState): string {
  if (!pause.until) return "until someone resumes it";
  const relative = relativeTime(pause.until);
  const lower = relative.charAt(0).toLowerCase() + relative.slice(1);
  return `until ${timeInSentence(pause.until)} (${lower})`;
}

export function addMinutes(minutes: number): string {
  return new Date(KIT_NOW.getTime() + minutes * 60_000).toISOString();
}

/* ----------------------------------------------------------------------------
   Pause and resume, shared by the General row and the workspace banner.
   -------------------------------------------------------------------------- */

export function usePauseActions() {
  const { pause, setPause, workspaceName } = useSettingsPreview();
  const pauseFor = (until: string | null, label: string) => {
    const before = pause;
    setPause({ paused: true, until });
    showUndoToast({
      title: `Paused agent work in ${workspaceName}`,
      description: label,
      onUndo: () => setPause(before),
    });
  };
  const resume = () => {
    const before = pause;
    setPause({ paused: false, until: null });
    showUndoToast({
      title: `Resumed agent work in ${workspaceName}`,
      description: "New sessions and scheduled runs can start again.",
      undoLabel: "Pause again",
      onUndo: () => setPause(before),
    });
  };
  return { pauseFor, resume };
}

/** The workspace-wide banner while agent work is paused (question 7). */
export function PausedBanner() {
  const { pause, canManage, workspaceName, questions } = useSettingsPreview();
  const { resume } = usePauseActions();
  // Today's pause is only visible on its own card; the banner is part of question 7.
  if (!pause.paused || questions.q7 === "no") return null;
  return (
    <Notice
      layout="banner"
      tone="info"
      live="polite"
      icon={<CirclePauseIcon className="size-4" />}
      actionLayout="responsive"
      action={
        canManage ? (
          <Button type="button" variant="outline" size="sm" onClick={resume}>
            Resume
          </Button>
        ) : undefined
      }
      className="shrink-0"
    >
      <span className="font-medium">Agent work in {workspaceName} is paused</span>{" "}
      <span className="text-fg-muted">
        {pauseUntilPhrase(pause)}.{canManage ? "" : " Ask Bendik Hansen to resume it."}
      </span>
    </Notice>
  );
}

/* ----------------------------------------------------------------------------
   Frame props every page shares.
   -------------------------------------------------------------------------- */

export function useFrameBase(): Omit<SettingsFrameProps, "children"> {
  const state = useSettingsPreview();
  return {
    page: state.page,
    onNavigate: state.navigate,
    nav: state.nav,
    settingsOnly: state.questions.q5 === "yes",
    dangerZonePage: state.questions.q6 === "no",
    workspaceName: state.workspaceName,
    viewer: state.viewerPerson,
    banner: <PausedBanner />,
    scrollKey: state.viewer,
  };
}

/**
 * FormPage and DetailPage share one frame (960px, 32px sides). Inside the
 * settings column the frame already has its padding, so detail pages pass
 * `px-0` and form pages drop the frame's sides here too: the back link and
 * title of both line up with the settings page header. The footer rule stops
 * with the 640px field column, like the header rule.
 */
export const FORM_PAGE_IN_SETTINGS =
  "[&_header]:mx-0 [&_header]:px-0 [&_header]:pt-0 [&_[data-slot=form-body]]:mx-0 [&_[data-slot=form-body]]:px-0 [&_footer]:max-w-[640px] [&_footer>div]:mx-0 [&_footer>div]:px-0";

/* ----------------------------------------------------------------------------
   Small pieces.
   -------------------------------------------------------------------------- */

/** A setting's current value under its label: 14px, full strength. */
export function RowValue({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-sm leading-5 break-words text-fg">{children}</span>;
}

/**
 * A control only workspace admins can use. Members keep it in view, disabled,
 * with the reason on hover, focus and tap.
 */
export function AdminOnly({
  children,
}: {
  children: Parameters<typeof DisabledReason>[0]["children"];
}) {
  const { canManage } = useSettingsPreview();
  if (canManage) return children;
  return <DisabledReason reason={ADMIN_ONLY_REASON}>{children}</DisabledReason>;
}

/**
 * A page that opened in place of the list (a detail page or a form page).
 * Focus moves to its heading (or, failing that, the back link), so keyboard
 * and screen reader users land on the new page instead of a row that no
 * longer exists.
 */
export function OpenedPage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>("h1[tabindex]") ??
      root?.querySelector<HTMLElement>("a[href], button");
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      {children}
    </div>
  );
}
