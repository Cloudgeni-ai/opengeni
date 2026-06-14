import type { KeyboardEvent } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  argHint,
  filterCommands,
  firstMissingRequiredArg,
  matchCommand,
  parseCommandLine,
} from "../commands/registry";
import type { CommandContext, Notice, SlashCommand } from "../commands/types";

/**
 * Context the composer supplies for command execution and visibility. The
 * composer owns the UI affordances (notice/openHelp/clearView/confirm), so they
 * are NOT part of this slice — the hook closes over them via `handlers`.
 */
export type SlashCommandContext = Pick<
  CommandContext,
  "client" | "workspaceId" | "sessionId" | "status" | "permissions"
>;

export type SlashCommandHandlers = Pick<CommandContext, "notice" | "openHelp" | "clearView" | "confirm">;

export type ConfirmState = {
  command: SlashCommand;
  /** Resolve the pending confirm() promise. */
  resolve: (confirmed: boolean) => void;
} | null;

export type UseSlashCommandsOptions = {
  commands: readonly SlashCommand[];
  context: SlashCommandContext | undefined;
  handlers: SlashCommandHandlers;
  /** The current composer draft. */
  value: string;
  /** Replace the composer draft (autocomplete writes through this). */
  setValue: (value: string) => void;
};

export type UseSlashCommandsResult = {
  /** Whether the palette is open (a command token is being typed). */
  open: boolean;
  /** Commands shown for the current token + context, in display order. */
  items: SlashCommand[];
  /** Index into `items` of the highlighted row. */
  highlight: number;
  setHighlight: (index: number) => void;
  /** The matched command once the name is closed by a space (arg-hint mode). */
  activeCommand: SlashCommand | null;
  /** The arg hint string for the active command (footer), or "". */
  activeArgHint: string;
  /**
   * Key handler for the textarea. Returns true when it consumed the event
   * (the composer must then NOT run its send path). Only consumes while open.
   */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Run the highlighted command (or the active command in arg-hint mode). */
  runHighlighted: () => Promise<void>;
  /** Autocomplete the highlighted command name + a trailing space. */
  autocompleteHighlighted: () => void;
};

export function useSlashCommands(options: UseSlashCommandsOptions): UseSlashCommandsResult {
  const { commands, context, handlers, value, setValue } = options;
  const [highlight, setHighlight] = useState(0);
  // Escape closes the palette but keeps the draft. We remember the dismissed
  // value; any further edit (value !== dismissed) re-opens the palette.
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const dismissed = dismissedValue !== null && dismissedValue === value;

  const parsed = useMemo(() => parseCommandLine(value), [value]);
  const filterCtx = useMemo(
    () => ({
      sessionId: context?.sessionId ?? null,
      status: context?.status ?? null,
      permissions: context?.permissions ?? [],
    }),
    [context?.sessionId, context?.status, context?.permissions],
  );

  // In arg-hint mode ("/name "), the list collapses to the matched command so
  // the palette shows just its arg hint; while typing the name it filters.
  const activeCommand = useMemo(() => {
    if (!parsed || !parsed.hasTrailingSpace) {
      return null;
    }
    return matchCommand(commands, value);
  }, [commands, value, parsed]);

  const items = useMemo(() => {
    if (!parsed) {
      return [];
    }
    if (activeCommand) {
      return [activeCommand];
    }
    return filterCommands(commands, parsed.name, filterCtx);
  }, [commands, parsed, activeCommand, filterCtx]);

  const open = parsed !== null && items.length > 0 && !dismissed;

  // Keep highlight in range as items change.
  const clampedHighlight = items.length === 0 ? 0 : Math.min(highlight, items.length - 1);

  const activeArgHint = activeCommand ? argHint(activeCommand.args) : "";

  const buildContext = useCallback(
    (): CommandContext | null => {
      if (!context) {
        return null;
      }
      return { ...context, ...handlers };
    },
    [context, handlers],
  );

  const execute = useCallback(
    async (command: SlashCommand, args: string[]): Promise<void> => {
      const ctx = buildContext();
      if (!ctx) {
        return;
      }
      try {
        const result = await command.run(args, ctx);
        if (result.message) {
          ctx.notice({ tone: result.status === "ok" ? "ok" : "error", message: result.message });
        }
        if (result.status === "ok") {
          setValue("");
        }
      } catch (cause) {
        ctx.notice({ tone: "error", message: errorMessage(cause) });
      }
    },
    [buildContext, setValue],
  );

  const autocomplete = useCallback(
    (command: SlashCommand) => {
      setValue(`/${command.name} `);
      setHighlight(0);
    },
    [setValue],
  );

  const autocompleteHighlighted = useCallback(() => {
    const command = items[clampedHighlight];
    if (command) {
      autocomplete(command);
    }
  }, [items, clampedHighlight, autocomplete]);

  const runHighlighted = useCallback(async (): Promise<void> => {
    if (!parsed) {
      return;
    }
    // When the typed token is an exact command name (e.g. "/clear" while the
    // longer "/clear-view" sits first in the filtered list), Enter should run
    // THAT command, not autocomplete the highlighted near-match. Exact match
    // wins over the highlight; otherwise use the highlighted row.
    const exact = items.find((item) => item.name === parsed.name || item.aliases?.includes(parsed.name));
    const command = activeCommand ?? exact ?? items[clampedHighlight];
    if (!command) {
      return;
    }
    // Enter on a name-only token first autocompletes (so "/cl"+Enter fills the
    // name); on a fully-typed command with a satisfied arg list it runs.
    if (!activeCommand && command.name !== parsed.name && !parsed.hasTrailingSpace) {
      autocomplete(command);
      return;
    }
    const missing = firstMissingRequiredArg(command, parsed.args);
    if (missing) {
      // A required arg is absent: keep the palette open at the arg hint rather
      // than firing a half-formed command.
      if (!parsed.hasTrailingSpace) {
        autocomplete(command);
      }
      return;
    }
    await execute(command, parsed.args);
  }, [parsed, activeCommand, items, clampedHighlight, autocomplete, execute]);

  // Track an in-flight run so Enter can't double-fire.
  const runningRef = useRef(false);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) {
        return false;
      }
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          setHighlight((current) => (items.length === 0 ? 0 : (Math.min(current, items.length - 1) + 1) % items.length));
          return true;
        }
        case "ArrowUp": {
          event.preventDefault();
          setHighlight((current) => {
            const base = Math.min(current, items.length - 1);
            return items.length === 0 ? 0 : (base - 1 + items.length) % items.length;
          });
          return true;
        }
        case "Tab": {
          event.preventDefault();
          autocompleteHighlighted();
          return true;
        }
        case "Enter": {
          if (event.shiftKey || event.nativeEvent?.isComposing) {
            return false;
          }
          event.preventDefault();
          if (runningRef.current) {
            return true;
          }
          runningRef.current = true;
          void runHighlighted().finally(() => {
            runningRef.current = false;
          });
          return true;
        }
        case "Escape": {
          event.preventDefault();
          // Close the palette but keep the draft intact. Remember the dismissed
          // value; the next edit re-opens (value !== dismissedValue).
          setDismissedValue(value);
          return true;
        }
        default:
          return false;
      }
    },
    [open, items, autocompleteHighlighted, runHighlighted, value],
  );

  return {
    open,
    items,
    highlight: clampedHighlight,
    setHighlight,
    activeCommand,
    activeArgHint,
    onKeyDown,
    runHighlighted,
    autocompleteHighlighted,
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
