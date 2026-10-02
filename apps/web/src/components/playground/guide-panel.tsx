import { CheckIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { QUESTIONS, type AgentSettings } from "./acme-script";
import { GUIDE_STEPS, type GuideState, type GuideStepId } from "./guide";
import { ACCENTS, CORNERS, type ChatStyle } from "./style-knobs";

/* ----------------------------------------------------------------------------
   The playground's steps, each with the control it is about. Every control
   works at any time; the guide only marks the step to try next, and says in
   one line what the last action did.
   -------------------------------------------------------------------------- */

export const STEP_TITLES: Record<GuideStepId, string> = {
  ask: "Send a message",
  style: "Click a color to restyle the chat",
  tools: "Turn on tools",
  ship: "Add it to your product",
};

const STEP_HINTS: Record<GuideStepId, string> = {
  ask: "Type in the chat, or pick a question.",
  style: "It updates live.",
  tools: "The agent can then look things up. Settings apply to new chats.",
  ship: "Your coding agent can set this up in a few minutes.",
};

const STEP_DONE: Record<GuideStepId, string> = {
  ask: "That's <OpenGeniChat />: streaming, steps and chat history built in.",
  style: "That's one CSS variable. See styles.css.",
  tools: "It used Acme's own API, through your MCP server.",
  ship: "",
};

export type AgentSettingId = keyof AgentSettings;

const SETTING_ROWS: readonly { id: AgentSettingId; title: string; description: string }[] = [
  { id: "tools", title: "Tools", description: "Looks up orders and charges in Acme." },
  { id: "memory", title: "Memory", description: "Remembers each customer across chats." },
  { id: "thinking", title: "Thinking", description: "Reasons before it answers." },
];

export function GuidePanel({
  guide,
  style,
  settings,
  playing,
  followUp,
  offerNewChat,
  onStyle,
  onSetting,
  onAsk,
  onSkip,
  shipAction,
}: {
  guide: GuideState;
  style: ChatStyle;
  settings: AgentSettings;
  /** An answer is playing: hold the question buttons. */
  playing: boolean;
  /** A follow-up the open chat's last answer invites ("Yes, refund it"). */
  followUp: string | null;
  /** The settings changed since the open chat started: offer a fresh one to see it. */
  offerNewChat: boolean;
  onStyle: (style: ChatStyle) => void;
  onSetting: (id: AgentSettingId, on: boolean) => void;
  /** Ask a question; `newChat` starts a chat with the current settings. */
  onAsk: (text: string, options: { newChat: boolean }) => void;
  onSkip: () => void;
  /** The link to the Developer settings, rendered by the route. */
  shipAction: ReactNode;
}) {
  const ask = (text: string, newChat: boolean, label = text) => (
    <button
      key={label}
      type="button"
      disabled={playing}
      onClick={() => onAsk(text, { newChat })}
      className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-xs text-fg transition-colors duration-[120ms] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 pointer-coarse:min-h-11"
    >
      {label}
    </button>
  );
  return (
    <ol aria-label="Try it in four steps" className="grid gap-1">
      <Step id="ask" guide={guide} onSkip={onSkip}>
        <div className="flex flex-wrap gap-1.5">
          {ask(QUESTIONS.order, false)}
          {ask(QUESTIONS.charged, false)}
          {followUp ? ask(followUp, false) : null}
        </div>
      </Step>
      <Step id="style" guide={guide} onSkip={onSkip}>
        <div className="grid gap-2.5">
          <div
            role="radiogroup"
            aria-label="Color"
            className="flex flex-wrap gap-2"
            onKeyDown={(event) => {
              const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
              if (!step) return;
              event.preventDefault();
              const index = ACCENTS.findIndex((accent) => accent.name === style.accent.name);
              const next = ACCENTS[(index + step + ACCENTS.length) % ACCENTS.length]!;
              onStyle({ ...style, accent: next });
              event.currentTarget
                .querySelector<HTMLElement>(`[aria-label="${next.name}"]`)
                ?.focus();
            }}
          >
            {ACCENTS.map((accent) => {
              const selected = style.accent.name === accent.name;
              return (
                <button
                  key={accent.name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  aria-label={accent.name}
                  title={accent.name}
                  className={cn(
                    "size-7 rounded-full border-2 outline-none transition-[box-shadow] duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11",
                    selected ? "border-surface ring-2 ring-fg" : "border-transparent",
                  )}
                  style={{ background: accent.value }}
                  onClick={() => onStyle({ ...style, accent })}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <SegmentedControl
              aria-label="Corners"
              size="sm"
              value={style.corners.name}
              onValueChange={(name) =>
                onStyle({ ...style, corners: CORNERS.find((entry) => entry.name === name)! })
              }
              options={CORNERS.map((entry) => ({ value: entry.name, label: entry.name }))}
            />
            <SegmentedControl
              aria-label="Theme"
              size="sm"
              value={style.theme}
              onValueChange={(theme) => onStyle({ ...style, theme })}
              options={[
                { value: "light", label: "Light", icon: <SunIcon aria-hidden="true" /> },
                { value: "dark", label: "Dark", icon: <MoonIcon aria-hidden="true" /> },
              ]}
            />
          </div>
        </div>
      </Step>
      <Step id="tools" guide={guide} onSkip={onSkip}>
        <div className="grid">
          {SETTING_ROWS.map((row) => (
            <label
              key={row.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 py-1"
              data-setting={row.id}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{row.title}</span>
                <span className="block text-xs text-fg-muted">{row.description}</span>
              </span>
              <Switch
                checked={settings[row.id]}
                onCheckedChange={(on) => onSetting(row.id, on)}
                aria-label={row.title}
              />
            </label>
          ))}
          {offerNewChat ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2" data-stale-chat="">
              <span className="text-xs text-fg-muted">Try it:</span>
              {ask(QUESTIONS.order, true, "Ask in a new chat")}
            </div>
          ) : null}
        </div>
      </Step>
      <Step id="ship" guide={guide} onSkip={onSkip}>
        {shipAction}
      </Step>
    </ol>
  );
}

function Step({
  id,
  guide,
  onSkip,
  children,
}: {
  id: GuideStepId;
  guide: GuideState;
  onSkip: () => void;
  children: ReactNode;
}) {
  const number = GUIDE_STEPS.indexOf(id) + 1;
  const current = guide.current === id;
  const done = guide.done.includes(id);
  const note = done && STEP_DONE[id] ? STEP_DONE[id] : STEP_HINTS[id];
  return (
    <li
      data-step={id}
      data-current={current ? "" : undefined}
      aria-current={current ? "step" : undefined}
      className={cn(
        "grid gap-3 rounded-[14px] border p-4 transition-colors duration-[120ms]",
        current ? "border-border-strong bg-surface" : "border-transparent",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-px grid size-5 shrink-0 place-items-center rounded-full text-2xs font-semibold",
            done
              ? "bg-status-idle/15 text-status-idle"
              : current
                ? "bg-selection text-fg ring-1 ring-border-strong"
                : "bg-surface-2 text-fg-muted",
          )}
        >
          {done ? <CheckIcon className="size-3" /> : number}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm leading-5 font-semibold text-fg">
            <span className="sr-only">
              Step {number}
              {done ? " (done)" : ""}:{" "}
            </span>
            {STEP_TITLES[id]}
          </h2>
          <p className="text-xs leading-[18px] text-fg-muted">{note}</p>
        </div>
        {current && id !== "ship" ? (
          <Button type="button" size="xs" variant="ghost" className="-my-0.5" onClick={onSkip}>
            Skip
          </Button>
        ) : null}
      </div>
      <div className="pl-8">{children}</div>
    </li>
  );
}
