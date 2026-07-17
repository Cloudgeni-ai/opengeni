import type { ClientModel, EffectiveSessionControl } from "@opengeni/sdk";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FileIcon,
  ImageIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { argHint } from "../commands/registry";
import type { Notice, SlashCommand } from "../commands/types";
import type { ComposerState } from "../hooks/use-composer";
import { shouldSteerOnKey, shouldSubmitOnKey } from "../hooks/use-composer";
import type { UseFileAttachmentsResult } from "../hooks/use-file-attachments";
import { defaultCommands } from "../commands/registry";
import {
  useSlashCommands,
  type ConfirmState,
  type SlashCommandContext,
} from "../hooks/use-slash-commands";
import { cn } from "../lib/cn";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { CommandPalette } from "./command-palette";
import { ModelPicker } from "./model-picker";

export type ChatComposerProps = {
  composer: ComposerState;
  /** Canonical workstream control, separate from lifecycle status. */
  effectiveControl?: EffectiveSessionControl | null | undefined;
  /** Waiting prompts already ahead of a normal Send. */
  queuedAheadCount?: number | undefined;
  /** Whether broader Workspace Resume is authorized for this viewer. */
  canControlWorkspace?: boolean | undefined;
  /** Optional host routes used to navigate from effective Pause blockers. */
  controlLinks?:
    | {
        workspaceHref?: string | undefined;
        sessionHref?: ((sessionId: string) => string) | undefined;
      }
    | undefined;
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
  /**
   * Opt-in file attachments. When supplied (e.g. from {@link useFileAttachments}),
   * the composer renders a built-in attach button (prepended to `controlsStart`),
   * an attachment-chips strip (above the textarea, before any host `header`),
   * routes paste through `addFromPaste` (image/* filter lives in the hook), and
   * gates send while `uploading` so a message never departs without its files.
   * Absent → no attachment UI renders and the composer behaves exactly as before.
   */
  attachments?: UseFileAttachmentsResult | undefined;
  /**
   * Opt-in model picker. When supplied (e.g. from {@link useAvailableModels}),
   * the composer renders a {@link ModelPicker} at the start of `controlsStart`
   * so the operator can choose which host-exposed model serves the next message.
   * The host owns the selection (`selectedModel`/`onSelectModel`) and is
   * responsible for threading it into the composer's `sendExtras` (typically
   * `useComposer({ sendExtras: () => ({ model }) })`) so `composeSendInput`
   * carries it. Absent → no picker renders and the composer behaves as before.
   */
  models?: ClientModel[] | undefined;
  /** The currently selected model id (the picker's controlled value). */
  selectedModel?: string | undefined;
  /** Called with the chosen model id when the operator picks one. */
  onSelectModel?: ((modelId: string) => void) | undefined;
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

export const OPEN_WORKSTREAM_CONTROL_EVENT = "opengeni:open-workstream-control";

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
  effectiveControl,
  queuedAheadCount = 0,
  canControlWorkspace = false,
  controlLinks,
  placeholder,
  disabled,
  autoFocus,
  hint,
  controlsStart,
  header,
  onPaste,
  attachments,
  models,
  selectedModel,
  onSelectModel,
  className,
  commands = defaultCommands,
  commandContext,
  onClearView,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const paused = effectiveControl?.state === "paused";
  const [controlDetailsOpen, setControlDetailsOpen] = useState(false);
  useEffect(() => {
    const openControl = () => {
      textareaRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      if (paused) {
        setControlDetailsOpen(true);
        return;
      }
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>('button[aria-label="Pause this workstream"]')
          ?.focus();
      });
    };
    document.addEventListener(OPEN_WORKSTREAM_CONTROL_EVENT, openControl);
    return () => document.removeEventListener(OPEN_WORKSTREAM_CONTROL_EVENT, openControl);
  }, [paused]);

  // Block sends while attachments are still uploading so a message never
  // departs without the files the user attached to it. This gates BOTH the
  // Enter-to-send path (which calls composer.send directly, bypassing canSend)
  // and the send button — dropping either path could ship a fileless message.
  const blockedByUpload = attachments?.uploading === true;

  // A ready attachment makes a file-only message (empty draft) sendable. The
  // composer (when wired with `sendExtras.resources`) already reflects this in
  // `canSend`; we OR it in here too so send-enablement is correct even for a
  // composer whose canSend doesn't know about attachments — and so this stays
  // the single home of the attachment send-gate.
  const hasReadyAttachment = (attachments?.readyResources.length ?? 0) > 0;
  // The send affordance: text OR a ready attachment, never mid-upload or mid-send.
  const canSend = (composer.canSend || hasReadyAttachment) && !blockedByUpload && !composer.sending;

  // Drag-and-drop file attach: only a drop target when `attachments` is wired,
  // and only reacts to drags that actually carry files (so it never hijacks
  // normal text drag/drop). `dragging` drives the drop overlay.
  const [dragging, setDragging] = useState(false);
  const dragCarriesFiles = (event: { dataTransfer: DataTransfer | null }): boolean =>
    event.dataTransfer != null && [...event.dataTransfer.types].includes("Files");
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachments || !dragCarriesFiles(event)) {
        return;
      }
      // preventDefault marks this a valid drop target so the browser fires drop.
      event.preventDefault();
      setDragging(true);
    },
    [attachments],
  );
  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachments) {
        return;
      }
      // Ignore leaves bubbling from children: only clear when the pointer left
      // the composer bounds entirely (the related target is outside it).
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setDragging(false);
    },
    [attachments],
  );
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachments || !dragCarriesFiles(event)) {
        return;
      }
      event.preventDefault();
      setDragging(false);
      // Same path the picker uses: addFiles accepts ALL files (no image filter).
      if (event.dataTransfer.files.length > 0) {
        attachments.addFiles(event.dataTransfer.files);
      }
    },
    [attachments],
  );

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
        setNotice({
          tone: "error",
          message:
            "That's a slash command — press Enter in the command list to run it, or edit the line to send a message.",
        });
        return;
      }
      if (blockedByUpload) {
        // Files are still uploading: swallow the Enter so the message can't
        // depart without them. The send button is disabled in the same state.
        return;
      }
      void (shouldSteerOnKey(event) ? composer.steer() : composer.send());
    }
  };

  // The host's onPaste still fires (model/tool/whatever paste handling); when
  // attachments are wired, also feed the clipboard through addFromPaste so the
  // image/* filter (owned by the hook) attaches pasted images.
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      onPaste?.(event);
      attachments?.addFromPaste(event);
    },
    [onPaste, attachments],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        attachments?.addFiles(event.target.files);
      }
      event.target.value = "";
    },
    [attachments],
  );

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

  const activeNotice =
    notice ??
    (composer.error
      ? {
          tone: "error" as const,
          message: /control changed|paused while/i.test(composer.error.message)
            ? "This workstream was paused while you were sending. Nothing was sent, and your draft is still here."
            : composer.error.message || "Sending failed — your draft is still here. Try again.",
        }
      : null);

  return (
    // Respect the iOS home-indicator inset so the sticky composer never sits
    // under it (0 on non-notch devices and desktop, so it's inert there).
    <div
      className={cn("og-root", className)}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
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
          // Drag-and-drop file attach lives on the field wrapper, but only when
          // `attachments` is wired — without it the composer is not a drop target
          // and behaves exactly as before.
          onDragOver={attachments ? handleDragOver : undefined}
          onDragLeave={attachments ? handleDragLeave : undefined}
          onDrop={attachments ? handleDrop : undefined}
          className={cn(
            "relative rounded-og-lg border border-og-border bg-og-surface-1 shadow-og-sm",
            "transition-[border-color,box-shadow] duration-200",
            "focus-within:border-og-accent/60 focus-within:shadow-og-glow",
            // While files are dragged over, swap to a dashed accent border to
            // signal a live drop target (the overlay carries the label).
            dragging && "border-dashed border-og-accent",
          )}
        >
          {dragging ? (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 z-10 flex items-center justify-center",
                "rounded-og-lg bg-og-surface-1/85 text-sm font-medium text-og-accent backdrop-blur-[1px]",
              )}
            >
              <span className="inline-flex items-center gap-2">
                <PaperclipIcon className="size-4" />
                Drop files to attach
              </span>
            </div>
          ) : null}
          {paused && effectiveControl ? (
            <WorkstreamPausedStrip
              control={effectiveControl}
              queuedAheadCount={queuedAheadCount}
              open={controlDetailsOpen}
              busy={composer.resuming}
              sending={composer.sending}
              canControlWorkspace={canControlWorkspace}
              controlLinks={controlLinks}
              onOpenChange={setControlDetailsOpen}
              onResume={() => void composer.resume()}
              onResumeOption={(option) => void composer.resumeScope(option)}
            />
          ) : null}
          {composer.restoredResources.length > 0 ? (
            <RestoredResourceChips
              resources={composer.restoredResources}
              onRemove={composer.removeRestoredResource}
            />
          ) : null}
          {attachments && attachments.attachments.length > 0 ? (
            <AttachmentChips
              attachments={attachments.attachments}
              onRemove={attachments.remove}
              onRetry={attachments.retry}
            />
          ) : null}
          {header}
          <textarea
            ref={textareaRef}
            rows={1}
            value={composer.value}
            onChange={(event) => composer.setValue(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            placeholder={
              paused && disabled !== true
                ? "Sending will resume this workstream…"
                : (placeholder ?? "Message the agent…")
            }
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label="Message the agent"
            aria-keyshortcuts="Enter Meta+Enter Control+Enter Shift+Enter"
            // A multiline textarea cannot legally take the combobox role or
            // aria-expanded. It remains a native textbox and advertises the
            // popup as list autocomplete; controls/active-descendant exist
            // only while the suggestion list itself exists.
            aria-autocomplete={paletteEnabled ? "list" : undefined}
            aria-controls={paletteEnabled && palette.open ? listboxId : undefined}
            aria-activedescendant={
              paletteEnabled && palette.open
                ? `${listboxId}-option-${palette.highlight}`
                : undefined
            }
            className={cn(
              // Font size steps up to 16px below `md` so iOS never zooms the
              // viewport on focus; desktop keeps the 15px og-md rhythm.
              "block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-6 md:text-og-md",
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
              returnFocusRef={textareaRef}
            />
          ) : (
            <div className="flex items-end gap-2 px-2.5 pb-2.5 pt-1">
              {attachments || models || controlsStart ? (
                // The control group wraps onto extra rows when it can't fit
                // (narrow viewports) instead of clipping under the rounded
                // corner; send/stop stays anchored bottom-right (shrink-0).
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {attachments ? (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      <button
                        type="button"
                        disabled={disabled === true}
                        onClick={() => fileInputRef.current?.click()}
                        aria-label="Attach files"
                        title="Attach files"
                        className={cn(
                          "inline-flex size-8 items-center justify-center rounded-og-md",
                          "text-og-fg-muted transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg",
                          "disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11",
                        )}
                      >
                        <PaperclipIcon className="size-4" />
                      </button>
                    </>
                  ) : null}
                  {models ? (
                    <ModelPicker
                      models={models}
                      value={selectedModel}
                      onChange={(modelId) => onSelectModel?.(modelId)}
                      disabled={disabled === true}
                    />
                  ) : null}
                  {controlsStart}
                </span>
              ) : (
                <span className="min-w-0 flex-1 px-1.5 text-og-xs text-og-fg-subtle max-sm:hidden">
                  {hint ?? "Enter to queue · Cmd/Ctrl+Enter to steer · Shift+Enter for a new line"}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {effectiveControl && !paused ? (
                  <button
                    type="button"
                    onClick={() => void composer.pause()}
                    disabled={composer.pausing || composer.resuming}
                    aria-label="Pause this workstream"
                    title="Pause this workstream; queued prompts and approvals are preserved"
                    className={cn(
                      "inline-flex size-8 items-center justify-center rounded-og-md border border-og-border pointer-coarse:size-11",
                      "bg-og-surface-2 text-og-fg-muted transition-colors duration-150",
                      "hover:border-og-status-waiting/50 hover:text-og-status-waiting",
                      "disabled:opacity-50",
                    )}
                  >
                    {composer.pausing || composer.resuming ? (
                      <LoaderCircleIcon className="size-3.5 animate-og-spin" />
                    ) : (
                      <PauseIcon className="size-3.5 fill-current" />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (blockedByUpload) {
                      return;
                    }
                    void composer.send();
                  }}
                  disabled={!canSend || disabled === true || commandDraftBlocked}
                  aria-label={paused ? "Send and resume" : "Send message"}
                  title={
                    paused
                      ? "Send & resume (Enter); Steer & resume with Cmd/Ctrl+Enter"
                      : "Queue message (Enter); steer with Cmd/Ctrl+Enter"
                  }
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-og-md pointer-coarse:size-11",
                    "bg-og-accent text-og-accent-fg shadow-og-sm",
                    "transition-[background-color,transform,opacity] duration-150 ease-og-spring",
                    "hover:bg-og-accent-strong active:scale-95",
                    "disabled:cursor-not-allowed disabled:bg-og-surface-3 disabled:text-og-fg-subtle disabled:shadow-none",
                  )}
                >
                  {composer.sending ? (
                    <LoaderCircleIcon className="size-4 animate-og-spin" />
                  ) : (
                    <ArrowUpIcon className="size-4" />
                  )}
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {helpOpen ? <HelpPanel commands={helpCommands} onClose={() => setHelpOpen(false)} /> : null}
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
                window.setTimeout(
                  () => setNotice((current) => (current === activeNotice ? null : current)),
                  2400,
                );
              }
            }}
          >
            {activeNotice.message}
          </motion.p>
        ) : null}
      </AnimatePresence>
      {composer.draftConflict ? (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-2 px-1 text-og-xs text-og-status-failed"
          role="alert"
        >
          <span className="min-w-0 flex-1">
            This draft changed in another tab. Your local draft is still here.
          </span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void composer.resolveDraftConflict("use_remote")}
          >
            Use other draft
          </button>
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => void composer.resolveDraftConflict("keep_mine")}
          >
            Keep mine
          </button>
        </div>
      ) : composer.draftSaving ? (
        <p className="px-1 pt-1 text-og-xs text-og-fg-subtle" role="status">
          Saving draft…
        </p>
      ) : null}
    </div>
  );
}

function WorkstreamPausedStrip({
  control,
  queuedAheadCount,
  open,
  busy,
  sending,
  canControlWorkspace,
  controlLinks,
  onOpenChange,
  onResume,
  onResumeOption,
}: {
  control: EffectiveSessionControl;
  queuedAheadCount: number;
  open: boolean;
  busy: boolean;
  sending: boolean;
  canControlWorkspace: boolean;
  controlLinks: ChatComposerProps["controlLinks"];
  onOpenChange: (open: boolean) => void;
  onResume: () => void;
  onResumeOption: (option: EffectiveSessionControl["resumeOptions"][number]) => void;
}) {
  const blocker = control.primaryBlocker;
  const cause =
    blocker?.kind === "workspace"
      ? "Workspace paused"
      : control.directState === "paused"
        ? "Paused here"
        : `Paused by ${blocker?.displayName ?? "parent"}`;
  const primary = control.resumeOptions.find((option) => option.scope === "selected");
  const broaderOptions = control.resumeOptions.filter(
    (option) =>
      option !== primary &&
      option.scope !== "selected" &&
      (option.scope !== "workspace" || canControlWorkspace),
  );
  return (
    <div className="border-b border-og-status-waiting/25 bg-og-status-waiting/[0.07]">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <PauseIcon className="size-3.5 shrink-0 text-og-status-waiting" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
        >
          <span className="block truncate text-og-xs font-medium text-og-fg">{cause}</span>
          <span className="block truncate text-[11px] text-og-fg-muted">
            {queuedAheadCount > 0
              ? `Send & resume queues behind ${queuedAheadCount} waiting prompt${queuedAheadCount === 1 ? "" : "s"}.`
              : sending
                ? "Resuming and sending…"
                : "Your next message resumes this workstream automatically."}
          </span>
        </button>
        <button
          type="button"
          aria-label="Resume this workstream"
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-og-md border border-og-status-waiting/35 bg-og-surface-1 px-2.5 text-og-xs font-medium text-og-fg hover:bg-og-surface-2 pointer-coarse:min-h-11"
          disabled={busy}
          onClick={onResume}
        >
          {busy ? (
            <LoaderCircleIcon className="size-3.5 animate-og-spin" />
          ) : (
            <PlayIcon className="size-3.5 fill-current" />
          )}
          <span className="hidden min-[400px]:inline">Resume this workstream</span>
          <span className="min-[400px]:hidden">Resume</span>
        </button>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-og-md text-og-fg-muted hover:bg-og-surface-2 pointer-coarse:size-11"
          onClick={() => onOpenChange(!open)}
          aria-label={open ? "Hide pause details" : "Show pause details"}
        >
          <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open ? (
        <div className="border-t border-og-status-waiting/20 px-3 pb-3 pt-2">
          <ul className="grid gap-2" aria-label="Reasons this workstream is paused">
            {control.blockers.map((entry, index) => (
              <li
                key={`${entry.kind}-${entry.sessionId ?? "workspace"}-${entry.revision}`}
                className="text-og-xs"
              >
                <span className="font-medium text-og-fg">
                  {index === 0 ? "Paused by " : "Also paused by "}
                </span>
                {blockerHref(entry, controlLinks) ? (
                  <a
                    href={blockerHref(entry, controlLinks)}
                    className="font-medium text-og-fg underline decoration-og-border-strong underline-offset-2 hover:text-og-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-ring/40"
                  >
                    {entry.displayName}
                  </a>
                ) : (
                  <span className="font-medium text-og-fg">{entry.displayName}</span>
                )}
                {entry.reason ? <span className="text-og-fg-muted"> · {entry.reason}</span> : null}
                {entry.actor ? <span className="text-og-fg-subtle"> · {entry.actor}</span> : null}
                {entry.changedAt ? (
                  <span className="text-og-fg-subtle">
                    {" "}
                    · {formatRelativeTime(entry.changedAt)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {broaderOptions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {broaderOptions.map((option) => (
                <button
                  key={`${option.scope}-${option.targetId ?? "selected"}`}
                  type="button"
                  disabled={busy}
                  title={option.impactCopy}
                  onClick={() => onResumeOption(option)}
                  className="rounded-og-md border border-og-border bg-og-surface-1 px-2 py-1 text-og-xs text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg pointer-coarse:min-h-10"
                >
                  <span className="block font-medium">
                    {option.scope === "workspace" ? "Resume workspace" : "Resume from this session"}
                  </span>
                  <span className="block text-[10px] text-og-fg-subtle">
                    {option.selectedStateAfter === "active"
                      ? "This session will be able to run"
                      : `Still paused by ${option.remainingPrimaryBlocker?.displayName ?? "a narrower pause"}`}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function blockerHref(
  blocker: EffectiveSessionControl["blockers"][number],
  links: ChatComposerProps["controlLinks"],
): string | undefined {
  if (blocker.kind === "workspace") return links?.workspaceHref;
  return blocker.sessionId ? links?.sessionHref?.(blocker.sessionId) : undefined;
}

function RestoredResourceChips({
  resources,
  onRemove,
}: {
  resources: ComposerState["restoredResources"];
  onRemove: (index: number) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-1.5 border-b border-og-border px-3 py-2"
      aria-label="Restored prompt resources"
    >
      {resources.map((resource, index) => (
        <span
          key={`${resource.kind}-${resource.kind === "file" ? resource.fileId : resource.uri}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-og-md border border-og-border bg-og-surface-2 px-2 py-1 text-og-xs text-og-fg-muted"
        >
          <FileIcon className="size-3 shrink-0" />
          <span className="truncate">
            {resource.kind === "file" ? `File ${resource.fileId.slice(0, 8)}` : resource.uri}
          </span>
          <button
            type="button"
            className="shrink-0 hover:text-og-fg"
            onClick={() => onRemove(index)}
            aria-label={`Remove restored resource ${index + 1}`}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * The danger confirm bar — reuses og-status-failed tokens (like the stop
 * control). Inline (not a modal) but keyboard-complete: Escape cancels, focus
 * moves to the primary action when it appears and returns to the composer on
 * dismiss, and the primary button names the action rather than a bare "Confirm".
 */
function ConfirmBar({
  command,
  onCancel,
  onConfirm,
  returnFocusRef,
}: {
  command: SlashCommand;
  onCancel: () => void;
  onConfirm: () => void;
  /** Focus returns here when the bar dismisses (the composer textarea). */
  returnFocusRef?: RefObject<HTMLTextAreaElement | null> | undefined;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const descriptionId = useId();
  useEffect(() => {
    const returnTo = returnFocusRef?.current ?? null;
    confirmRef.current?.focus();
    return () => {
      returnTo?.focus();
    };
  }, [returnFocusRef]);
  return (
    <div
      role="alertdialog"
      aria-label={`Confirm /${command.name}`}
      aria-describedby={descriptionId}
      data-testid="danger-confirm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex items-end justify-between gap-2 px-2.5 pb-2.5 pt-1"
    >
      <span id={descriptionId} className="min-w-0 flex-1 px-1.5 text-og-sm text-og-status-failed">
        Run <span className="font-mono">/{command.name}</span>? {command.description}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-og-md border border-og-border bg-og-surface-2 px-2.5 py-1 text-og-sm text-og-fg-muted hover:bg-og-surface-3 pointer-coarse:min-h-10"
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="rounded-og-md border border-og-status-failed/50 bg-og-status-failed/15 px-2.5 py-1 text-og-sm text-og-status-failed hover:bg-og-status-failed/25 pointer-coarse:min-h-10"
        >
          Run /{command.name}
        </button>
      </span>
    </div>
  );
}

/**
 * The attachment-chips strip rendered above the textarea while files are
 * attached. Each chip shows an image preview (or a type icon), the filename,
 * an upload/size/failed status line, and a remove control. A failed upload
 * surfaces its actual error (inline, full text on hover via `title`) and offers
 * a retry alongside remove — a failed attachment never blocks send (only an
 * in-progress upload does), and removing it clears the way. Styled with the
 * package's og-* tokens so it themes in any consumer.
 */
function AttachmentChips({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: UseFileAttachmentsResult["attachments"];
  onRemove: (id: string) => void;
  onRetry?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-og-border px-3 py-2">
      {attachments.map((attachment) => {
        const failed = attachment.status === "failed";
        const statusText =
          attachment.status === "uploading"
            ? "Uploading"
            : failed
              ? attachment.error || "Upload failed"
              : formatBytes(attachment.sizeBytes);
        return (
          <div
            key={attachment.id}
            className={cn(
              "flex min-w-0 max-w-[240px] items-center gap-2 rounded-og-md border px-2 py-1.5 text-og-sm",
              failed
                ? "border-og-status-failed/40 bg-og-status-failed/10"
                : "border-og-border bg-og-surface-2",
            )}
          >
            {attachment.previewUrl ? (
              <img
                src={attachment.previewUrl}
                alt=""
                className="size-8 shrink-0 rounded object-cover"
              />
            ) : attachment.contentType.startsWith("image/") ? (
              <ImageIcon className="size-4 shrink-0 text-og-fg-muted" />
            ) : (
              <FileIcon className="size-4 shrink-0 text-og-fg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-og-fg">{attachment.name}</div>
              <div
                className={cn(
                  "truncate text-og-xs",
                  failed ? "text-og-status-failed" : "text-og-fg-subtle",
                )}
                title={failed ? statusText : undefined}
              >
                {statusText}
              </div>
            </div>
            {attachment.status === "uploading" ? (
              <LoaderCircleIcon className="size-3.5 shrink-0 animate-og-spin" />
            ) : null}
            {failed && onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(attachment.id)}
                className="shrink-0 rounded-og-xs p-1 text-og-fg-muted hover:bg-og-surface-1 hover:text-og-fg pointer-coarse:size-10"
                aria-label={`Retry ${attachment.name}`}
                title="Retry upload"
              >
                <RotateCwIcon className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className="shrink-0 rounded-og-xs p-1 text-og-fg-muted hover:bg-og-surface-1 hover:text-og-fg pointer-coarse:size-10"
              aria-label={`Remove ${attachment.name}`}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The in-composer /help panel, rendered entirely from the registry. */
function HelpPanel({
  commands,
  onClose,
}: {
  commands: readonly SlashCommand[];
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-2 overflow-hidden rounded-og-lg border border-og-border bg-og-surface-2"
    >
      <div className="flex items-center justify-between border-b border-og-border px-3 py-1.5">
        <span className="text-og-sm font-medium text-og-fg">Commands</span>
        <button
          type="button"
          onClick={onClose}
          className="text-og-xs text-og-fg-subtle hover:text-og-fg"
        >
          Close
        </button>
      </div>
      <ul className="py-1">
        {commands.map((command) => {
          const hint = argHint(command.args);
          return (
            <li key={command.name} className="flex items-baseline gap-2 px-3 py-1">
              <span className="font-mono text-og-sm text-og-accent">
                /{command.name}
                {hint ? <span className="ml-1 text-og-fg-subtle">{hint}</span> : null}
              </span>
              <span className="text-og-sm text-og-fg-muted">{command.description}</span>
              {command.danger ? (
                <span className="ml-auto rounded-og-xs bg-og-status-failed/15 px-1 text-og-xs uppercase tracking-wide text-og-status-failed">
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
