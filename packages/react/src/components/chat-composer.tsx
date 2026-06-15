import type { SessionStatus } from "@opengeni/sdk";
import { ArrowUpIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { argHint } from "../commands/registry";
import type { Notice, SlashCommand } from "../commands/types";
import type { ComposerState } from "../hooks/use-composer";
import { shouldSubmitOnKey } from "../hooks/use-composer";
import { defaultCommands } from "../commands/registry";
import { useSlashCommands, type ConfirmState, type SlashCommandContext } from "../hooks/use-slash-commands";
import { cn } from "../lib/cn";
import { CommandPalette } from "./command-palette";

export type ChatComposerProps = {
  composer: ComposerState;
  /** Current session status; shows the stop control while a turn runs. */
  status?: SessionStatus | null | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Replaces the default keyboard hint under the field. */
  hint?: string | undefined;
  /** App controls (model picker, attach button, ...) in the footer row, replacing the hint. */
  controlsStart?: ReactNode | undefined;
  /** Content rendered above the textarea, inside the field chrome (e.g. attachment chips). */
  header?: ReactNode | undefined;
  /** Paste hook on the textarea (e.g. paste-image-to-attach). */
  onPaste?: ((event: ClipboardEvent<HTMLTextAreaElement>) => void) | undefined;
  className?: string | undefined;
  /**
   * Slash-command palette. Defaults to the built-in {@link defaultCommands};
   * apps concat their own. Backward-compatible: when `commandContext` is absent
   * the palette is inert and behavior is identical to before.
   */
  commands?: readonly SlashCommand[] | undefined;
  /**
   * Wiring the palette needs to run server commands and gate visibility. The
   * composer supplies notice/openHelp/clearView/confirm internally.
   */
  commandContext?: SlashCommandContext | undefined;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView?: (() => void) | undefined;
};

const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["queued", "running"]);

/**
 * The chat composer — the only human-to-agent input surface. Plain chat in,
 * everything else is the agent's job. Enter sends, Shift+Enter breaks the
 * line, and the stop control appears while a turn is running (sending while
 * running is legitimate steering, so send stays available too).
 *
 * Typing a leading "/" opens the slash-command palette — SESSION/OPERATOR
 * controls (clear, compact, pause goal, help), never a structured channel to
 * the agent. The palette is purely additive: with no `commandContext` it is
 * inert and the composer behaves exactly as before.
 */
export function ChatComposer({
  composer,
  status,
  placeholder,
  disabled,
  autoFocus,
  hint,
  controlsStart,
  header,
  onPaste,
  className,
  commands = defaultCommands,
  commandContext,
  onClearView,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const active = status != null && ACTIVE_STATUSES.has(status);

  const [notice, setNotice] = useState<Notice | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const listboxId = useId();

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [composer.value, resize]);

  // The UI affordances commands reach: surface a notice, open the help panel,
  // reset the local view, and the danger confirm flow (resolves when the
  // operator confirms/cancels in the confirm bar).
  const handlers = useMemo(
    () => ({
      notice: (next: Notice) => {
        setNotice(next);
        composer.clearError();
      },
      openHelp: () => setHelpOpen(true),
      // Report whether a view-reset was actually wired by the host: with no
      // onClearView the command is a no-op and must say so (not a false success).
      clearView: () => {
        if (!onClearView) {
          return false;
        }
        onClearView();
        return true;
      },
      // The hook binds the command actually being run into confirm() (see
      // use-slash-commands buildContext), so the confirm bar renders from THAT
      // command — never a near-match highlighted in the palette. This is what
      // keeps the destructive /clear from being mislabeled as /clear-view.
      confirm: (command: SlashCommand) =>
        new Promise<boolean>((resolve) => {
          setConfirmState({
            command,
            resolve: (confirmed) => {
              setConfirmState(null);
              resolve(confirmed);
            },
          });
        }),
    }),
    [composer, onClearView],
  );

  const palette = useSlashCommands({
    commands,
    context: commandContext,
    handlers,
    value: composer.value,
    setValue: composer.setValue,
  });

  // The confirm bar renders from the command the hook is actually running —
  // carried into confirmState by handlers.confirm — NOT a near-match that
  // happens to be highlighted/active in the palette. (Re-deriving it from
  // palette.items[palette.highlight] mislabeled the destructive /clear as the
  // harmless /clear-view, since clear-view prefix-matches "clear" and sorts
  // first.)
  const pendingDangerCommand = confirmState ? confirmState.command : null;

  const paletteEnabled = commandContext !== undefined;

  // A slash-command draft must never be delivered to the agent as chat — it is
  // an operator control, not a message. The palette consumes Enter while open,
  // but after Escape the popover is closed yet the draft still matches a command;
  // block the send path (here and on the send button) so "/clear" can't be sent.
  const commandDraftBlocked = paletteEnabled && palette.isCommandDraft;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Palette key handling runs FIRST and only when the palette is open; when
    // closed it returns false and the existing send path is untouched.
    if (paletteEnabled && palette.onKeyDown(event)) {
      return;
    }
    if (shouldSubmitOnKey(event)) {
      event.preventDefault();
      if (commandDraftBlocked) {
        // Dismissed palette + a "/command" draft: don't send it as chat. Nudge
        // the operator to re-open the palette (any edit re-opens it) or clear it.
        setNotice({ tone: "error", message: "That's a slash command — press Enter in the command list to run it, or edit the line to send a message." });
        return;
      }
      void composer.send();
    }
  };

  const helpCommands = useMemo(
    () =>
      commands.filter((command) => {
        if (command.permission && commandContext) {
          const perms = commandContext.permissions;
          return perms.includes(command.permission) || perms.includes("workspace:admin");
        }
        return true;
      }),
    [commands, commandContext],
  );

  const activeNotice = notice ?? (composer.error ? { tone: "error" as const, message: composer.error.message || "Sending failed — your draft is still here. Try again." } : null);

  return (
    <div className={cn("og-root", className)}>
      <div className="relative">
        {paletteEnabled ? (
          <CommandPalette
            open={palette.open && confirmState === null}
            items={palette.items}
            highlight={palette.highlight}
            onHighlight={palette.setHighlight}
            onRun={(index) => {
              // Run the CLICKED row directly. We must not route a pointer click
              // through runHighlighted: its exact-match override would re-resolve
              // "/clear" to the destructive clear even when the operator clicked
              // the harmless clear-view row. runAt honors the explicit selection.
              palette.setHighlight(index);
              void palette.runAt(index);
            }}
            argHintText={palette.activeArgHint}
            listboxId={listboxId}
          />
        ) : null}
        <div
          className={cn(
            "rounded-og-lg border border-og-border bg-og-surface-1 shadow-og-sm",
            "transition-[border-color,box-shadow] duration-200",
            "focus-within:border-og-accent/60 focus-within:shadow-og-glow",
          )}
        >
          {header}
          <textarea
            ref={textareaRef}
            rows={1}
            value={composer.value}
            onChange={(event) => composer.setValue(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder ?? "Message the agent…"}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label="Message the agent"
            role={paletteEnabled && palette.open ? "combobox" : undefined}
            aria-expanded={paletteEnabled ? palette.open : undefined}
            aria-controls={paletteEnabled && palette.open ? listboxId : undefined}
            aria-activedescendant={paletteEnabled && palette.open ? `${listboxId}-option-${palette.highlight}` : undefined}
            className={cn(
              "block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6",
              // The wrapper owns the whole-composer focus affordance (focus-within
              // border + soft glow). Suppress any self-scoped focus outline on the
              // textarea itself: `focus:outline-none` alone only sets outline-style
              // on `:focus`, which a host app's zero-specificity
              // `:where(...):focus-visible { outline: ... }` base rule re-applies as
              // the full shorthand. `focus-visible:outline-none` matches the same
              // state at class specificity and wins, so no second highlight (the
              // top-half rectangle bounded to the textarea box) ever paints.
              "text-og-fg placeholder:text-og-fg-subtle focus:outline-none focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          {confirmState && pendingDangerCommand ? (
            <ConfirmBar
              command={pendingDangerCommand}
              onCancel={() => confirmState.resolve(false)}
              onConfirm={() => confirmState.resolve(true)}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
              {controlsStart ? (
                <span className="flex min-w-0 items-center gap-1.5">{controlsStart}</span>
              ) : (
                <span className="px-1.5 text-[11px] text-og-fg-subtle max-sm:hidden">
                  {hint ?? "Enter to send · Shift+Enter for a new line · / for commands"}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <AnimatePresence initial={false}>
                  {active ? (
                    <motion.button
                      key="stop"
                      type="button"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      onClick={() => void composer.interrupt()}
                      disabled={composer.interrupting}
                      aria-label="Stop the current turn"
                      title="Stop the current turn"
                      className={cn(
                        "inline-flex size-8 items-center justify-center rounded-og-md border border-og-border",
                        "bg-og-surface-2 text-og-fg-muted transition-colors duration-150",
                        "hover:border-og-status-failed/50 hover:text-og-status-failed",
                        "disabled:opacity-50",
                      )}
                    >
                      {composer.interrupting ? (
                        <LoaderCircleIcon className="size-3.5 animate-og-spin" />
                      ) : (
                        <SquareIcon className="size-3 fill-current" />
                      )}
                    </motion.button>
                  ) : null}
                </AnimatePresence>
                <button
                  type="button"
                  onClick={() => void composer.send()}
                  disabled={!composer.canSend || disabled === true || commandDraftBlocked}
                  aria-label="Send message"
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-og-md",
                    "bg-og-accent text-og-accent-fg shadow-og-sm",
                    "transition-[background-color,transform,opacity] duration-150 ease-og-spring",
                    "hover:bg-og-accent-strong active:scale-95",
                    "disabled:cursor-not-allowed disabled:bg-og-surface-3 disabled:text-og-fg-subtle disabled:shadow-none",
                  )}
                >
                  {composer.sending ? <LoaderCircleIcon className="size-4 animate-og-spin" /> : <ArrowUpIcon className="size-4" />}
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {helpOpen ? (
          <HelpPanel commands={helpCommands} onClose={() => setHelpOpen(false)} />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {activeNotice ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className={cn(
              "overflow-hidden px-1 pt-1.5 text-xs",
              activeNotice.tone === "ok" ? "text-og-fg-muted" : "text-og-status-failed",
            )}
            role={activeNotice.tone === "error" ? "alert" : "status"}
            onAnimationComplete={() => {
              if (activeNotice.tone === "ok") {
                // Auto-dismiss success notices after a beat.
                window.setTimeout(() => setNotice((current) => (current === activeNotice ? null : current)), 2400);
              }
            }}
          >
            {activeNotice.message}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The danger confirm bar — reuses og-status-failed tokens (like the stop control). */
function ConfirmBar({ command, onCancel, onConfirm }: { command: SlashCommand; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      role="alertdialog"
      aria-label={`Confirm /${command.name}`}
      data-testid="danger-confirm"
      className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1"
    >
      <span className="px-1.5 text-[12px] text-og-status-failed">
        Run <span className="font-mono">/{command.name}</span>? {command.description}
      </span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-og-md border border-og-border bg-og-surface-2 px-2.5 py-1 text-[12px] text-og-fg-muted hover:bg-og-surface-3"
        >
          Cancel
        </button>
        <button
          type="button"
          autoFocus
          onClick={onConfirm}
          className="rounded-og-md border border-og-status-failed/50 bg-og-status-failed/15 px-2.5 py-1 text-[12px] text-og-status-failed hover:bg-og-status-failed/25"
        >
          Confirm
        </button>
      </span>
    </div>
  );
}

/** The in-composer /help panel, rendered entirely from the registry. */
function HelpPanel({ commands, onClose }: { commands: readonly SlashCommand[]; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-2 overflow-hidden rounded-og-lg border border-og-border bg-og-surface-2"
    >
      <div className="flex items-center justify-between border-b border-og-border px-3 py-1.5">
        <span className="text-[12px] font-medium text-og-fg">Commands</span>
        <button type="button" onClick={onClose} className="text-[11px] text-og-fg-subtle hover:text-og-fg">
          Close
        </button>
      </div>
      <ul className="py-1">
        {commands.map((command) => {
          const hint = argHint(command.args);
          return (
            <li key={command.name} className="flex items-baseline gap-2 px-3 py-1">
              <span className="font-mono text-[12px] text-og-accent">
                /{command.name}
                {hint ? <span className="ml-1 text-og-fg-subtle">{hint}</span> : null}
              </span>
              <span className="text-[12px] text-og-fg-muted">{command.description}</span>
              {command.danger ? (
                <span className="ml-auto rounded-og-xs bg-og-status-failed/15 px-1 text-[10px] uppercase tracking-wide text-og-status-failed">
                  danger
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}
