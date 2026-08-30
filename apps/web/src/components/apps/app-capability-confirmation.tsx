import type { AppToolDescriptor } from "@opengeni/sdk/apps";
import { ShieldCheckIcon } from "lucide-react";
import { useId, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";

export function appRunCanStart(tools: readonly AppToolDescriptor[], confirmed: boolean): boolean {
  return tools.length === 0 || confirmed;
}

export function AppCapabilityConfirmation({
  tools,
  confirmed,
  busy,
  onConfirmedChange,
  onStart,
}: {
  tools: readonly AppToolDescriptor[];
  confirmed: boolean;
  busy: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onStart: () => void;
}) {
  const descriptionId = useId();
  const canStart = appRunCanStart(tools, confirmed) && !busy;
  const startFromKeyboard = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canStart) {
      event.preventDefault();
      onStart();
    }
  };

  return (
    <fieldset
      className="rounded-xl border border-border bg-surface/45 p-4"
      onKeyDown={startFromKeyboard}
    >
      <legend className="px-1 text-sm font-semibold text-fg">Access for this run</legend>
      {tools.length === 0 ? (
        <p className="text-sm leading-5 text-fg-muted">
          This app does not request any OpenGeni tools. It still runs inside the isolated Apps
          frame.
        </p>
      ) : (
        <>
          <p id={descriptionId} className="text-sm leading-5 text-fg-muted">
            Review the {tools.length.toLocaleString()} read-only{" "}
            {tools.length === 1 ? "tool" : "tools"} this app may use. The grant lasts only for this
            browser run and is enforced before a request reaches the control transport.
          </p>
          <ul
            tabIndex={0}
            className="mt-3 grid max-h-80 gap-2 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Requested read-only tools"
          >
            {tools.map((tool) => (
              <li
                key={`${tool.identity.serverId}\u0000${tool.identity.toolName}`}
                className="rounded-lg bg-surface-2/55 px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <ShieldCheckIcon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-brand"
                  />
                  <div className="min-w-0">
                    <div className="break-words text-sm font-medium text-fg">
                      {tool.title ?? tool.programmaticPath.join(".")}
                    </div>
                    <div className="mt-0.5 text-xs leading-4 text-fg-muted">
                      {tool.description || "Read-only, replay-safe app tool"}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm text-fg focus-within:ring-2 focus-within:ring-ring/50">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
              checked={confirmed}
              aria-describedby={descriptionId}
              onChange={(event) => onConfirmedChange(event.currentTarget.checked)}
            />
            <span>I allow these tools for this run.</span>
          </label>
        </>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" disabled={!canStart} onClick={onStart} className="min-h-11">
          {busy ? "Starting…" : "Start app"}
        </Button>
        <span className="text-2xs text-fg-subtle">Keyboard: Ctrl/⌘ + Enter</span>
      </div>
    </fieldset>
  );
}
