import { AnimatePresence, motion } from "motion/react";
import { argHint } from "../commands/registry";
import type { SlashCommand } from "../commands/types";
import { cn } from "../lib/cn";

export type CommandPaletteProps = {
  open: boolean;
  items: SlashCommand[];
  highlight: number;
  /** Hover/click selects a row. */
  onHighlight: (index: number) => void;
  /** Click runs the row (same path as Enter). */
  onRun: (index: number) => void;
  /** Footer arg hint shown in arg-hint mode (e.g. "<pause|resume>"). */
  argHintText: string;
  /** id used for aria-activedescendant wiring from the textarea. */
  listboxId: string;
};

/**
 * The slash-command palette: a popover anchored above the textarea, rendered
 * entirely from the filtered registry. Dark-first, Linear/Vercel-calm, using
 * the opengeni#46 design tokens. Full keyboard nav lives in useSlashCommands;
 * this component is presentational + aria.
 */
export function CommandPalette({
  open,
  items,
  highlight,
  onHighlight,
  onRun,
  argHintText,
  listboxId,
}: CommandPaletteProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.99 }}
          transition={{ duration: 0.13, ease: "easeOut" }}
          className={cn(
            "absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden",
            "rounded-og-lg border border-og-border bg-og-surface-2 shadow-og-sm",
          )}
        >
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Slash commands"
            className="max-h-72 overflow-y-auto py-1"
          >
            {items.map((command, index) => {
              const selected = index === highlight;
              const hint = argHint(command.args);
              return (
                <li
                  key={command.name}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => onHighlight(index)}
                  onMouseDown={(event) => {
                    // Keep textarea focus; run on click.
                    event.preventDefault();
                    onRun(index);
                  }}
                  className={cn(
                    "mx-1 flex cursor-pointer items-center gap-2 rounded-og-md px-2.5 py-1.5",
                    "transition-colors duration-100",
                    selected
                      ? "bg-og-accent/15 text-og-fg"
                      : "text-og-fg-muted hover:bg-og-surface-3",
                  )}
                >
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span
                      className={cn(
                        "font-mono text-[13px]",
                        selected ? "text-og-accent" : "text-og-fg",
                      )}
                    >
                      /{command.name}
                    </span>
                    {hint ? (
                      <span className="truncate font-mono text-[11px] text-og-fg-subtle">
                        {hint}
                      </span>
                    ) : null}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {command.danger ? (
                      <span className="rounded-og-xs bg-og-status-failed/15 px-1 text-[10px] uppercase tracking-wide text-og-status-failed">
                        danger
                      </span>
                    ) : null}
                    <span className="truncate text-[12px] text-og-fg-subtle max-sm:hidden">
                      {command.description}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          {argHintText ? (
            <div className="border-t border-og-border px-3 py-1.5 font-mono text-[11px] text-og-fg-subtle">
              {argHintText}
            </div>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
