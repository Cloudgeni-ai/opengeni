/**
 * What starts the agent, as a grid of tiles: a schedule, the person's event
 * sources and every kind of source they can still add, each with its app's
 * logo (or its glyph or initial). `agentTriggerOptions` builds the options
 * from the source catalog; this only draws them. One radio group: arrow keys
 * move between tiles. A source that is off or needs attention shows greyed
 * with why, and can't be picked.
 */
import { useRef, type KeyboardEvent } from "react";
import { CalendarClockIcon } from "lucide-react";

import {
  EventSourceTile,
  type EventSourceLogoResolver,
} from "../../../components/automations/event-source-tile";
import { selectableSurface } from "../../../ui/choice-cards";
import { LogoTile } from "../../../ui/logo-tile";
import { cn } from "../../../lib/cn";
import type { AgentTriggerOption } from "./agent-trigger-model";

export function AgentTriggerPicker({
  options,
  value,
  onChange,
  sourceLogo,
  error,
}: {
  options: readonly AgentTriggerOption[];
  /** The picked option's key; null before one is picked. */
  value: string | null;
  onChange: (option: AgentTriggerOption) => void;
  sourceLogo?: EventSourceLogoResolver | undefined;
  error?: string | undefined;
}) {
  const group = useRef<HTMLDivElement>(null);
  const pickable = options.filter((option) => !option.unavailable);
  const focusable = value ?? pickable[0]?.key;
  const move = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const index = pickable.findIndex((option) => option.key === key);
    const next = pickable[(index + step + pickable.length) % pickable.length];
    if (!next) return;
    onChange(next);
    group.current
      ?.querySelector<HTMLButtonElement>(`[data-agent-trigger-option="${CSS.escape(next.key)}"]`)
      ?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        ref={group}
        role="radiogroup"
        aria-label="Starts when"
        aria-invalid={error ? true : undefined}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {options.map((option) => {
          const selected = option.key === value;
          const unavailable = option.unavailable;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={Boolean(unavailable)}
              tabIndex={option.key === focusable ? 0 : -1}
              data-agent-trigger-option={option.key}
              onClick={() => onChange(option)}
              onKeyDown={(event) => move(event, option.key)}
              title={unavailable}
              className={selectableSurface(
                selected,
                cn(
                  "flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                  unavailable && "cursor-not-allowed opacity-60",
                ),
              )}
            >
              {option.subject ? (
                <EventSourceTile source={option.subject} logo={sourceLogo} size="sm" />
              ) : (
                <LogoTile size="sm" name={option.label} icon={<CalendarClockIcon />} />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg" title={option.label}>
                  {option.label}
                </span>
                {unavailable ? (
                  <span className="truncate text-xs text-fg-muted">{unavailable}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
