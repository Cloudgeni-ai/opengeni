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

/**
 * UI affordances the composer supplies. `confirm` differs from the registry-
 * facing {@link CommandContext.confirm} (which takes no args): the composer's
 * confirm receives the command being run so the confirm bar renders from that
 * exact command's identity. The hook bridges the two in {@link buildContext}.
 */
export type SlashCommandHandlers = Pick<CommandContext, "notice" | "openHelp" | "clearView"> & {
  confirm: (command: SlashCommand) => Promise<boolean>;
};

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
  /**
   * Run the command at an explicitly chosen index (a pointer click on a row).
   * Bypasses the exact-match token heuristic that runHighlighted uses for
   * keyboard Enter, so an explicit click always runs the clicked command.
   */
  runAt: (index: number) => Promise<void>;
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

  // Build the context for a SPECIFIC command. The danger confirm() is bound to
  // that command so the confirm bar names the command actually about to run —
  // not whatever near-match happens to sit highlighted in the palette (e.g.
  // typing "/clear"+Enter runs the destructive `clear`, but `clear-view` sorts
  // first and would otherwise mislabel the bar as a harmless local-view reset).
  const buildContext = useCallback(
    (command: SlashCommand): CommandContext | null => {
      if (!context) {
        return null;
      }
      return { ...context, ...handlers, confirm: () => handlers.confirm(command) };
    },
    [context, handlers],
  );

  const execute = useCallback(
    async (command: SlashCommand, args: string[]): Promise<void> => {
      const ctx = buildContext(command);
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

  // Resolve a SPECIFIC, already-chosen command against the current draft, then
  // either autocomplete (name-only / required arg missing) or execute. This is
  // the shared core for both Enter (which first resolves WHICH command via the
  // exact-match heuristic) and a pointer click (which has ALREADY chosen the
  // command — the clicked row — and must not re-resolve to a near-match).
  const runResolved = useCallback(
    async (command: SlashCommand, options?: { explicit?: boolean }): Promise<void> => {
      if (!parsed) {
        return;
      }
      const explicit = options?.explicit ?? false;
      // A name-only token whose name doesn't yet equal the resolved command (e.g.
      // "/cl" -> clear) first autocompletes so the operator sees the full name.
      // An EXPLICIT pointer click skips this: the operator already chose the row,
      // so clicking "/clear-view" (while the token is "clear") runs it outright
      // rather than merely filling the name and waiting for a second Enter.
      if (!explicit && !activeCommand && command.name !== parsed.name && !parsed.hasTrailingSpace) {
        autocomplete(command);
        return;
      }
      // When the click resolves a different command than the typed token, the
      // typed token's tail isn't this command's args — run with no positional
      // args and let the required-arg guard below prompt for them via autocomplete.
      const args = command.name === parsed.name || parsed.hasTrailingSpace ? parsed.args : [];
      const missing = firstMissingRequiredArg(command, args);
      if (missing) {
        // A required arg is absent: keep the palette open at the arg hint rather
        // than firing a half-formed command.
        if (!parsed.hasTrailingSpace) {
          autocomplete(command);
        }
        return;
      }
      await execute(command, args);
    },
    [parsed, activeCommand, autocomplete, execute],
  );

  const runHighlighted = useCallback(async (): Promise<void> => {
    if (!parsed) {
      return;
    }
    // When the typed token is an exact command name (e.g. "/clear" while the
    // longer "/clear-view" sits first in the filtered list), Enter should run
    // THAT command, not autocomplete the highlighted near-match. Exact match
    // wins over the highlight; otherwise use the highlighted row. This heuristic
    // is reserved for KEYBOARD Enter, where the user has not explicitly pointed
    // at a row — a pointer click goes through runAt and bypasses it entirely.
    const exact = items.find((item) => item.name === parsed.name || item.aliases?.includes(parsed.name));
    const command = activeCommand ?? exact ?? items[clampedHighlight];
    if (!command) {
      return;
    }
    await runResolved(command);
  }, [parsed, activeCommand, items, clampedHighlight, runResolved]);

  // Run the command at an EXPLICITLY chosen index (a pointer click on a palette
  // row). Unlike runHighlighted this does NOT apply the exact-match override:
  // clicking the harmless `/clear-view` row while the draft is "/clear" must run
  // clear-view, never the destructive `/clear` that exact-matches the token. The
  // operator's pointer is the selection; token-resolution heuristics don't apply.
  const runAt = useCallback(
    async (index: number): Promise<void> => {
      const command = items[index];
      if (!command) {
        return;
      }
      await runResolved(command, { explicit: true });
    },
    [items, runResolved],
  );

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
    runAt,
    autocompleteHighlighted,
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
