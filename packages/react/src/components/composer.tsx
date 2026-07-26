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
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { argHint, defaultCommands } from "../commands/registry";
import type { Notice, SlashCommand } from "../commands/types";
import type { ComposerState } from "../hooks/use-composer";
import { shouldSteerOnKey, shouldSubmitOnKey } from "../hooks/use-composer";
import type { UseFileAttachmentsResult } from "../hooks/use-file-attachments";
import {
  useSlashCommands,
  type ConfirmState,
  type SlashCommandContext,
} from "../hooks/use-slash-commands";
import { cn } from "../lib/cn";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { CommandPalette as CommandPaletteView } from "./command-palette";
import { ModelPicker as ModelPickerView } from "./model-picker";

export const OPEN_WORKSTREAM_CONTROL_EVENT = "opengeni:open-workstream-control";

export type ComposerDelivery = Pick<
  ComposerState,
  "value" | "setValue" | "send" | "steer" | "sending" | "canSend" | "error" | "clearError"
>;

export type ComposerDraftState = Pick<
  ComposerState,
  | "draftConflict"
  | "draftSaving"
  | "resolveDraftConflict"
  | "restoredResources"
  | "removeRestoredResource"
>;

export type ComposerControlState = Pick<
  ComposerState,
  "pause" | "pausing" | "resume" | "resumeScope" | "resuming"
>;

export type ComposerControlLinks = {
  workspaceHref?: string | undefined;
  sessionHref?: ((sessionId: string) => string) | undefined;
};

export type ChatComposerMessages = {
  messagePlaceholder: string;
  pausedPlaceholder: string;
  inputLabel: string;
  keyboardHint: string;
  slashCommandBlocked: string;
  controlChangedError: string;
  sendFailedError: string;
  dropFiles: string;
  attachFiles: string;
  pauseAriaLabel: string;
  pauseTitle: string;
  sendMessageAriaLabel: string;
  sendAndResumeAriaLabel: string;
  sendTitle: string;
  sendAndResumeTitle: string;
  workspacePaused: string;
  pausedHere: string;
  parentBlocker: string;
  narrowerPause: string;
  pausedBy: (displayName: string) => string;
  queuedAhead: (count: number) => string;
  resumingAndSending: string;
  nextMessageResumes: string;
  resumeThisWorkstream: string;
  resumeShort: string;
  hidePauseDetails: string;
  showPauseDetails: string;
  pauseReasonsLabel: string;
  pausedByLabel: string;
  alsoPausedByLabel: string;
  resumeWorkspace: string;
  resumeFromSession: string;
  sessionCanRun: string;
  stillPausedBy: (displayName: string) => string;
  restoredResourcesLabel: string;
  restoredFile: (fileId: string) => string;
  removeRestoredResource: (index: number) => string;
  uploading: string;
  uploadFailed: string;
  retryAttachment: (name: string) => string;
  retryUpload: string;
  removeAttachment: (name: string) => string;
  confirmCommand: (name: string) => string;
  confirmDescription: (command: SlashCommand) => string;
  cancel: string;
  runCommand: (name: string) => string;
  commands: string;
  slashCommandsLabel: string;
  modelLabel: string;
  close: string;
  danger: string;
  draftConflict: string;
  useOtherDraft: string;
  keepMine: string;
  savingDraft: string;
  formatBytes: (bytes: number) => string;
  formatRelativeTime: (changedAt: string) => string;
};

export const defaultChatComposerMessages: ChatComposerMessages = {
  messagePlaceholder: "Message the agent…",
  pausedPlaceholder: "Sending will resume this workstream…",
  inputLabel: "Message the agent",
  keyboardHint: "Enter to queue · Cmd/Ctrl+Enter to steer · Shift+Enter for a new line",
  slashCommandBlocked:
    "That's a slash command — press Enter in the command list to run it, or edit the line to send a message.",
  controlChangedError:
    "This workstream was paused while you were sending. Nothing was sent, and your draft is still here.",
  sendFailedError: "Sending failed — your draft is still here. Try again.",
  dropFiles: "Drop files to attach",
  attachFiles: "Attach files",
  pauseAriaLabel: "Pause this workstream",
  pauseTitle: "Pause this workstream; queued prompts and approvals are preserved",
  sendMessageAriaLabel: "Send message",
  sendAndResumeAriaLabel: "Send and resume",
  sendTitle: "Queue message (Enter); steer with Cmd/Ctrl+Enter",
  sendAndResumeTitle: "Send & resume (Enter); Steer & resume with Cmd/Ctrl+Enter",
  workspacePaused: "Workspace paused",
  pausedHere: "Paused here",
  parentBlocker: "parent",
  narrowerPause: "a narrower pause",
  pausedBy: (displayName) => `Paused by ${displayName}`,
  queuedAhead: (count) =>
    `Send & resume queues behind ${count} waiting prompt${count === 1 ? "" : "s"}.`,
  resumingAndSending: "Resuming and sending…",
  nextMessageResumes: "Your next message resumes this workstream automatically.",
  resumeThisWorkstream: "Resume this workstream",
  resumeShort: "Resume",
  hidePauseDetails: "Hide pause details",
  showPauseDetails: "Show pause details",
  pauseReasonsLabel: "Reasons this workstream is paused",
  pausedByLabel: "Paused by ",
  alsoPausedByLabel: "Also paused by ",
  resumeWorkspace: "Resume workspace",
  resumeFromSession: "Resume from this session",
  sessionCanRun: "This session will be able to run",
  stillPausedBy: (displayName) => `Still paused by ${displayName}`,
  restoredResourcesLabel: "Restored prompt resources",
  restoredFile: (fileId) => `File ${fileId.slice(0, 8)}`,
  removeRestoredResource: (index) => `Remove restored resource ${index + 1}`,
  uploading: "Uploading",
  uploadFailed: "Upload failed",
  retryAttachment: (name) => `Retry ${name}`,
  retryUpload: "Retry upload",
  removeAttachment: (name) => `Remove ${name}`,
  confirmCommand: (name) => `Confirm /${name}`,
  confirmDescription: (command) => `Run /${command.name}? ${command.description}`,
  cancel: "Cancel",
  runCommand: (name) => `Run /${name}`,
  commands: "Commands",
  slashCommandsLabel: "Slash commands",
  modelLabel: "Model",
  close: "Close",
  danger: "danger",
  draftConflict: "This draft changed in another tab. Your local draft is still here.",
  useOtherDraft: "Use other draft",
  keepMine: "Keep mine",
  savingDraft: "Saving draft…",
  formatBytes,
  formatRelativeTime,
};

export type ComposerSubmitMode = "queue" | "steer";
export type ComposerSubmitBlocker =
  | "disabled"
  | "uploading"
  | "sending"
  | "command"
  | "empty"
  | null;

export type UseChatComposerControllerOptions = {
  delivery: ComposerDelivery;
  draft?: ComposerDraftState | undefined;
  control?: ComposerControlState | undefined;
  effectiveControl?: EffectiveSessionControl | null | undefined;
  queuedAheadCount?: number | undefined;
  canControlWorkspace?: boolean | undefined;
  controlLinks?: ComposerControlLinks | undefined;
  disabled?: boolean | undefined;
  attachments?: UseFileAttachmentsResult | undefined;
  commands?: readonly SlashCommand[] | undefined;
  commandContext?: SlashCommandContext | undefined;
  onClearView?: (() => void) | undefined;
  onPaste?: ((event: ClipboardEvent<HTMLTextAreaElement>) => void) | undefined;
  messages?: Partial<ChatComposerMessages> | undefined;
};

/**
 * Headless interaction layer for a chat composer. It is the single owner of
 * delivery guards, keyboard routing, command interception, drag/drop, focus,
 * confirmation, and feedback state used by both the preset and primitives.
 */
export function useChatComposerController({
  delivery,
  draft,
  control,
  effectiveControl,
  queuedAheadCount = 0,
  canControlWorkspace = false,
  controlLinks,
  disabled = false,
  attachments,
  commands = defaultCommands,
  commandContext,
  onClearView,
  onPaste,
  messages: messageOverrides,
}: UseChatComposerControllerOptions) {
  const messages = useMemo(
    () => ({ ...defaultChatComposerMessages, ...messageOverrides }),
    [messageOverrides],
  );
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pauseButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const paused = effectiveControl?.state === "paused";
  const [controlDetailsOpen, setControlDetailsOpen] = useState(false);
  const [paletteMounted, setPaletteMounted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const controlOperationRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const openControl = (event: Event) => {
      const requestedId =
        event instanceof CustomEvent &&
        isRecord(event.detail) &&
        typeof event.detail.composerId === "string"
          ? event.detail.composerId
          : null;
      if (requestedId && requestedId !== id) return;
      if (!requestedId) {
        const roots = document.querySelectorAll("[data-og-composer-id]");
        if (roots.length > 1 && !rootRef.current?.contains(document.activeElement)) return;
      }
      textareaRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      if (paused) {
        setControlDetailsOpen(true);
        return;
      }
      window.requestAnimationFrame(() => pauseButtonRef.current?.focus());
    };
    document.addEventListener(OPEN_WORKSTREAM_CONTROL_EVENT, openControl);
    return () => document.removeEventListener(OPEN_WORKSTREAM_CONTROL_EVENT, openControl);
  }, [id, paused]);

  const blockedByUpload = attachments?.uploading === true;
  const hasReadyAttachment = (attachments?.readyResources.length ?? 0) > 0;

  const [dragging, setDragging] = useState(false);
  const dragCarriesFiles = (event: { dataTransfer: DataTransfer | null }): boolean =>
    event.dataTransfer !== null && [...event.dataTransfer.types].includes("Files");
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachments || !dragCarriesFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    },
    [attachments],
  );
  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachments) return;
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    [attachments],
  );
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachments || !dragCarriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files.length > 0) attachments.addFiles(event.dataTransfer.files);
    },
    [attachments],
  );

  const [notice, setNotice] = useState<Notice | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const pendingConfirm = useRef<((confirmed: boolean) => void) | null>(null);

  const settleConfirmation = useCallback((confirmed: boolean) => {
    const resolve = pendingConfirm.current;
    pendingConfirm.current = null;
    setConfirmState(null);
    resolve?.(confirmed);
  }, []);

  useEffect(
    () => () => {
      pendingConfirm.current?.(false);
      pendingConfirm.current = null;
    },
    [],
  );

  const resizeInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, []);
  useEffect(() => resizeInput(), [delivery.value, resizeInput]);

  const handlers = useMemo(
    () => ({
      notice: (next: Notice) => {
        setNotice(next);
        delivery.clearError();
      },
      openHelp: () => setHelpOpen(true),
      clearView: () => {
        if (!onClearView) return false;
        onClearView();
        return true;
      },
      confirm: (command: SlashCommand) =>
        new Promise<boolean>((resolve) => {
          pendingConfirm.current?.(false);
          pendingConfirm.current = resolve;
          setConfirmState({ command, resolve: settleConfirmation });
        }),
    }),
    [delivery, onClearView, settleConfirmation],
  );

  const palette = useSlashCommands({
    commands,
    context: commandContext,
    handlers,
    value: delivery.value,
    setValue: delivery.setValue,
  });
  const paletteEnabled = commandContext !== undefined;
  const commandDraftBlocked = paletteEnabled && palette.isCommandDraft;

  const submitBlocker: ComposerSubmitBlocker = disabled
    ? "disabled"
    : blockedByUpload
      ? "uploading"
      : delivery.sending || submitting
        ? "sending"
        : commandDraftBlocked
          ? "command"
          : delivery.canSend || hasReadyAttachment
            ? null
            : "empty";
  const canSubmit = submitBlocker === null;

  const submit = useCallback(
    async (mode: ComposerSubmitMode): Promise<boolean> => {
      if (commandDraftBlocked) {
        setNotice({ tone: "error", message: messages.slashCommandBlocked });
        delivery.clearError();
        return false;
      }
      if (disabled || blockedByUpload || delivery.sending || submittingRef.current) return false;
      if (!delivery.canSend && !hasReadyAttachment) return false;
      submittingRef.current = true;
      setSubmitting(true);
      try {
        return mode === "steer" ? await delivery.steer() : await delivery.send();
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    },
    [
      blockedByUpload,
      commandDraftBlocked,
      delivery,
      disabled,
      hasReadyAttachment,
      messages.slashCommandBlocked,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (paletteEnabled && paletteMounted && palette.onKeyDown(event)) return;
      if (!shouldSubmitOnKey(event)) return;
      event.preventDefault();
      void submit(shouldSteerOnKey(event) ? "steer" : "queue");
    },
    [palette, paletteEnabled, paletteMounted, submit],
  );
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      onPaste?.(event);
      attachments?.addFromPaste(event);
    },
    [attachments, onPaste],
  );
  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) attachments?.addFiles(event.target.files);
      event.target.value = "";
    },
    [attachments],
  );

  const helpCommands = useMemo(
    () =>
      commands.filter((command) => {
        if (command.permission && commandContext) {
          const permissions = commandContext.permissions;
          return (
            permissions.includes(command.permission) || permissions.includes("workspace:admin")
          );
        }
        return true;
      }),
    [commandContext, commands],
  );
  const activeNotice =
    notice ??
    (delivery.error
      ? {
          tone: "error" as const,
          message: /control changed|paused while/i.test(delivery.error.message)
            ? messages.controlChangedError
            : delivery.error.message || messages.sendFailedError,
        }
      : null);
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = window.setTimeout(
      () => setNotice((current) => (current === notice ? null : current)),
      2400,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  const runControlOperation = useCallback(async (operation: () => Promise<void>) => {
    if (controlOperationRef.current) return false;
    controlOperationRef.current = true;
    try {
      await operation();
      return true;
    } finally {
      controlOperationRef.current = false;
    }
  }, []);

  const pause = useCallback(
    async (reason?: string): Promise<boolean> => {
      if (!control || control.pausing || control.resuming) return false;
      return await runControlOperation(() => control.pause(reason));
    },
    [control, runControlOperation],
  );
  const resume = useCallback(
    async (reason?: string): Promise<boolean> => {
      if (!control || control.pausing || control.resuming) return false;
      return await runControlOperation(() => control.resume(reason));
    },
    [control, runControlOperation],
  );
  const resumeScope = useCallback(
    async (option: EffectiveSessionControl["resumeOptions"][number]): Promise<boolean> => {
      if (!control || control.pausing || control.resuming) return false;
      return await runControlOperation(() => control.resumeScope(option));
    },
    [control, runControlOperation],
  );

  return {
    id,
    rootRef,
    textareaRef,
    pauseButtonRef,
    fileInputRef,
    listboxId,
    effectiveControl,
    queuedAheadCount,
    canControlWorkspace,
    controlLinks,
    disabled,
    attachments,
    messages,
    sending: delivery.sending || submitting,
    error: delivery.error,
    clearError: delivery.clearError,
    hasDraftState: draft !== undefined,
    draftConflict: draft?.draftConflict ?? null,
    draftSaving: draft?.draftSaving ?? false,
    restoredResources: draft?.restoredResources ?? [],
    removeRestoredResource: draft?.removeRestoredResource,
    resolveDraftConflict: draft?.resolveDraftConflict,
    hasControl: control !== undefined,
    pausing: control?.pausing ?? false,
    resuming: control?.resuming ?? false,
    pause,
    resume,
    resumeScope,
    paused,
    controlDetailsOpen,
    setControlDetailsOpen,
    paletteMounted,
    setPaletteMounted,
    dragging,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    palette,
    paletteEnabled,
    commandDraftBlocked,
    confirmState,
    settleConfirmation,
    helpOpen,
    setHelpOpen,
    helpCommands,
    activeNotice,
    canSubmit,
    submitBlocker,
    submit,
    handleKeyDown,
    handlePaste,
    handleFileChange,
    focusInput: () => textareaRef.current?.focus(),
    setValue: delivery.setValue,
    value: delivery.value,
  };
}

export type ChatComposerController = ReturnType<typeof useChatComposerController>;

const ComposerContext = createContext<ChatComposerController | null>(null);

function useComposerController(): ChatComposerController {
  const controller = useContext(ComposerContext);
  if (!controller) throw new Error("useChatComposer must be used inside <Composer.Root>");
  return controller;
}

export type ChatComposerContextValue = Pick<
  ChatComposerController,
  | "id"
  | "value"
  | "setValue"
  | "focusInput"
  | "submit"
  | "canSubmit"
  | "submitBlocker"
  | "disabled"
  | "sending"
  | "error"
  | "clearError"
  | "attachments"
  | "messages"
  | "effectiveControl"
  | "paused"
  | "hasControl"
  | "pausing"
  | "resuming"
  | "pause"
  | "resume"
  | "resumeScope"
>;

/** Read the nearest compound composer's safe accessory-facing state and actions. */
export function useChatComposer(): ChatComposerContextValue {
  return useComposerController();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ComposerRootProps = Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  controller: ChatComposerController;
  children: ReactNode;
};

export const Root = forwardRef<HTMLDivElement, ComposerRootProps>(function ComposerRoot(
  { controller, children, className, style, ...props },
  forwardedRef,
) {
  return (
    <ComposerContext.Provider value={controller}>
      <div
        {...props}
        ref={mergeRefs(controller.rootRef, forwardedRef)}
        data-og-composer-id={controller.id}
        className={cn("og-root", className)}
        style={{ paddingBottom: "env(safe-area-inset-bottom)", ...style }}
      >
        {children}
        <ComposerAnnouncements />
      </div>
    </ComposerContext.Provider>
  );
});

export type ComposerFrameProps = ComponentPropsWithoutRef<"div">;

export const Frame = forwardRef<HTMLDivElement, ComposerFrameProps>(function ComposerFrame(
  { className, ...props },
  ref,
) {
  return <div {...props} ref={ref} className={cn("relative", className)} />;
});

export type ComposerCommandPaletteProps = { className?: string | undefined };

export function CommandPalette({ className }: ComposerCommandPaletteProps) {
  const controller = useComposerController();
  const setPaletteMounted = controller.setPaletteMounted;
  useEffect(() => {
    setPaletteMounted(true);
    return () => setPaletteMounted(false);
  }, [setPaletteMounted]);
  if (!controller.paletteEnabled) return null;
  return (
    <div className={className}>
      <CommandPaletteView
        open={controller.palette.open && controller.confirmState === null}
        items={controller.palette.items}
        highlight={controller.palette.highlight}
        onHighlight={controller.palette.setHighlight}
        onRun={(index) => {
          controller.palette.setHighlight(index);
          void controller.palette.runAt(index);
        }}
        argHintText={controller.palette.activeArgHint}
        listboxId={controller.listboxId}
        label={controller.messages.slashCommandsLabel}
        dangerLabel={controller.messages.danger}
      />
    </div>
  );
}

type OwnedSurfaceProps = "onDragOver" | "onDragLeave" | "onDrop";
export type ComposerSurfaceProps = Omit<ComponentPropsWithoutRef<"div">, OwnedSurfaceProps>;

export const Surface = forwardRef<HTMLDivElement, ComposerSurfaceProps>(function ComposerSurface(
  { className, children, ...props },
  ref,
) {
  const controller = useComposerController();
  return (
    <div
      {...props}
      ref={ref}
      onDragOver={controller.attachments ? controller.handleDragOver : undefined}
      onDragLeave={controller.attachments ? controller.handleDragLeave : undefined}
      onDrop={controller.attachments ? controller.handleDrop : undefined}
      className={cn(
        "relative rounded-og-lg border border-og-border bg-og-surface-1 shadow-og-sm",
        "transition-[border-color,box-shadow] duration-200",
        "focus-within:border-og-accent/60 focus-within:shadow-og-glow",
        controller.dragging && "border-dashed border-og-accent",
        className,
      )}
    >
      {controller.dragging ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-10 flex items-center justify-center",
            "rounded-og-lg bg-og-surface-1/85 text-sm font-medium text-og-accent backdrop-blur-[1px]",
          )}
        >
          <span className="inline-flex items-center gap-2">
            <PaperclipIcon className="size-4" />
            {controller.messages.dropFiles}
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
});

export function PausedState() {
  const controller = useComposerController();
  if (!controller.paused || !controller.effectiveControl || !controller.hasControl) return null;
  return (
    <WorkstreamPausedStrip
      control={controller.effectiveControl}
      queuedAheadCount={controller.queuedAheadCount}
      open={controller.controlDetailsOpen}
      busy={controller.resuming}
      sending={controller.sending}
      canControlWorkspace={controller.canControlWorkspace}
      controlLinks={controller.controlLinks}
      messages={controller.messages}
      onOpenChange={controller.setControlDetailsOpen}
      onResume={() => void controller.resume()}
      onResumeOption={(option) => void controller.resumeScope(option)}
    />
  );
}

export function RestoredResources() {
  const controller = useComposerController();
  if (controller.restoredResources.length === 0 || !controller.removeRestoredResource) return null;
  return (
    <RestoredResourceChips
      resources={controller.restoredResources}
      messages={controller.messages}
      onRemove={controller.removeRestoredResource}
    />
  );
}

export function Attachments() {
  const controller = useComposerController();
  if (!controller.attachments || controller.attachments.attachments.length === 0) return null;
  return (
    <AttachmentChips
      attachments={controller.attachments.attachments}
      messages={controller.messages}
      onRemove={controller.attachments.remove}
      onRetry={controller.attachments.retry}
    />
  );
}

type OwnedInputProps =
  | "value"
  | "defaultValue"
  | "onChange"
  | "onKeyDown"
  | "onPaste"
  | "disabled"
  | "aria-autocomplete"
  | "aria-controls"
  | "aria-activedescendant"
  | "aria-keyshortcuts";
export type ComposerInputProps = Omit<ComponentPropsWithoutRef<"textarea">, OwnedInputProps>;

export const Input = forwardRef<HTMLTextAreaElement, ComposerInputProps>(function ComposerInput(
  { rows = 1, placeholder, className, "aria-label": ariaLabel, ...props },
  forwardedRef,
) {
  const controller = useComposerController();
  const paletteOpen =
    controller.paletteEnabled && controller.paletteMounted && controller.palette.open;
  return (
    <textarea
      {...props}
      ref={mergeRefs(controller.textareaRef, forwardedRef)}
      rows={rows}
      value={controller.value}
      onChange={(event) => controller.setValue(event.target.value)}
      onKeyDown={controller.handleKeyDown}
      onPaste={controller.handlePaste}
      placeholder={
        controller.paused && !controller.disabled
          ? controller.messages.pausedPlaceholder
          : (placeholder ?? controller.messages.messagePlaceholder)
      }
      disabled={controller.disabled}
      aria-label={ariaLabel ?? controller.messages.inputLabel}
      aria-keyshortcuts="Enter Meta+Enter Control+Enter Shift+Enter"
      aria-autocomplete={
        controller.paletteEnabled && controller.paletteMounted ? "list" : undefined
      }
      aria-controls={paletteOpen ? controller.listboxId : undefined}
      aria-activedescendant={
        paletteOpen ? `${controller.listboxId}-option-${controller.palette.highlight}` : undefined
      }
      className={cn(
        "block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-6 md:text-og-md",
        "text-og-fg placeholder:text-og-fg-subtle focus:outline-none focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    />
  );
});

export function Confirmation() {
  const controller = useComposerController();
  const command = controller.confirmState?.command;
  if (!command || !controller.confirmState) return null;
  return (
    <ConfirmBar
      command={command}
      messages={controller.messages}
      onCancel={() => controller.settleConfirmation(false)}
      onConfirm={() => controller.settleConfirmation(true)}
      returnFocusRef={controller.textareaRef}
    />
  );
}

export type ComposerFooterProps = ComponentPropsWithoutRef<"div">;

export const Footer = forwardRef<HTMLDivElement, ComposerFooterProps>(function ComposerFooter(
  { className, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn("flex items-end gap-2 px-2.5 pb-2.5 pt-1", className)}
    />
  );
});

export type ComposerControlsProps = ComponentPropsWithoutRef<"span">;

export const Controls = forwardRef<HTMLSpanElement, ComposerControlsProps>(
  function ComposerControls({ className, ...props }, ref) {
    return (
      <span
        {...props}
        ref={ref}
        className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-1.5", className)}
      />
    );
  },
);

export type ComposerHintProps = ComponentPropsWithoutRef<"span">;

export const Hint = forwardRef<HTMLSpanElement, ComposerHintProps>(function ComposerHint(
  { className, children, ...props },
  ref,
) {
  const controller = useComposerController();
  return (
    <span
      {...props}
      ref={ref}
      className={cn("min-w-0 flex-1 px-1.5 text-og-xs text-og-fg-subtle max-sm:hidden", className)}
    >
      {children ?? controller.messages.keyboardHint}
    </span>
  );
});

export type ComposerActionsProps = ComponentPropsWithoutRef<"span">;

export const Actions = forwardRef<HTMLSpanElement, ComposerActionsProps>(function ComposerActions(
  { className, ...props },
  ref,
) {
  return (
    <span
      {...props}
      ref={ref}
      className={cn("ml-auto flex shrink-0 items-center gap-1.5", className)}
    />
  );
});

type OwnedButtonProps = "type" | "onClick" | "disabled";
export type ComposerAttachButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  OwnedButtonProps
> & {
  accept?: string | undefined;
  multiple?: boolean | undefined;
};

export const AttachButton = forwardRef<HTMLButtonElement, ComposerAttachButtonProps>(
  function ComposerAttachButton(
    { accept, multiple = true, className, "aria-label": ariaLabel, title, children, ...props },
    ref,
  ) {
    const controller = useComposerController();
    if (!controller.attachments) return null;
    return (
      <>
        <input
          ref={controller.fileInputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={controller.handleFileChange}
        />
        <button
          {...props}
          ref={ref}
          type="button"
          disabled={controller.disabled}
          onClick={() => controller.fileInputRef.current?.click()}
          aria-label={ariaLabel ?? controller.messages.attachFiles}
          title={title ?? controller.messages.attachFiles}
          className={cn(
            "inline-flex size-8 items-center justify-center rounded-og-md",
            "text-og-fg-muted transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg",
            "disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11",
            className,
          )}
        >
          {children ?? <PaperclipIcon className="size-4" />}
        </button>
      </>
    );
  },
);

export type ComposerModelPickerProps = {
  models: ClientModel[];
  value?: string | undefined;
  onChange?: ((modelId: string) => void) | undefined;
  label?: string | undefined;
  className?: string | undefined;
};

export function ModelPicker({
  models,
  value,
  onChange,
  label,
  className,
}: ComposerModelPickerProps) {
  const controller = useComposerController();
  return (
    <ModelPickerView
      models={models}
      value={value}
      onChange={(modelId) => onChange?.(modelId)}
      disabled={controller.disabled}
      label={label ?? controller.messages.modelLabel}
      className={className}
    />
  );
}

export type ComposerPauseButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  OwnedButtonProps
>;

export const PauseButton = forwardRef<HTMLButtonElement, ComposerPauseButtonProps>(
  function ComposerPauseButton(
    { className, "aria-label": ariaLabel, title, children, ...props },
    ref,
  ) {
    const controller = useComposerController();
    if (!controller.effectiveControl || controller.paused || !controller.hasControl) return null;
    const busy = controller.pausing || controller.resuming;
    return (
      <button
        {...props}
        ref={mergeRefs(controller.pauseButtonRef, ref)}
        type="button"
        onClick={() => void controller.pause()}
        disabled={busy}
        aria-label={ariaLabel ?? controller.messages.pauseAriaLabel}
        title={title ?? controller.messages.pauseTitle}
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-og-md border border-og-border pointer-coarse:size-11",
          "bg-og-surface-2 text-og-fg-muted transition-colors duration-150",
          "hover:border-og-status-waiting/50 hover:text-og-status-waiting",
          "disabled:opacity-50",
          className,
        )}
      >
        {children ??
          (busy ? (
            <LoaderCircleIcon className="size-3.5 animate-og-spin" />
          ) : (
            <PauseIcon className="size-3.5 fill-current" />
          ))}
      </button>
    );
  },
);

export type ComposerSendButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  OwnedButtonProps
>;

export const SendButton = forwardRef<HTMLButtonElement, ComposerSendButtonProps>(
  function ComposerSendButton(
    { className, "aria-label": ariaLabel, title, children, ...props },
    ref,
  ) {
    const controller = useComposerController();
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        onClick={() => void controller.submit("queue")}
        disabled={!controller.canSubmit}
        aria-label={
          ariaLabel ??
          (controller.paused
            ? controller.messages.sendAndResumeAriaLabel
            : controller.messages.sendMessageAriaLabel)
        }
        title={
          title ??
          (controller.paused
            ? controller.messages.sendAndResumeTitle
            : controller.messages.sendTitle)
        }
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-og-md pointer-coarse:size-11",
          "bg-og-accent text-og-accent-fg shadow-og-sm",
          "transition-[background-color,transform,opacity] duration-150 ease-og-spring",
          "hover:bg-og-accent-strong active:scale-95",
          "disabled:cursor-not-allowed disabled:bg-og-surface-3 disabled:text-og-fg-subtle disabled:shadow-none",
          className,
        )}
      >
        {children ??
          (controller.sending ? (
            <LoaderCircleIcon className="size-4 animate-og-spin" />
          ) : (
            <ArrowUpIcon className="size-4" />
          ))}
      </button>
    );
  },
);

export function Help() {
  const controller = useComposerController();
  return (
    <AnimatePresence>
      {controller.helpOpen ? (
        <HelpPanel
          commands={controller.helpCommands}
          messages={controller.messages}
          onClose={() => controller.setHelpOpen(false)}
        />
      ) : null}
    </AnimatePresence>
  );
}

export function Status() {
  const controller = useComposerController();
  return (
    <>
      <AnimatePresence>
        {controller.activeNotice ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className={cn(
              "overflow-hidden px-1 pt-1.5 text-xs",
              controller.activeNotice.tone === "ok" ? "text-og-fg-muted" : "text-og-status-failed",
            )}
          >
            {controller.activeNotice.message}
          </motion.p>
        ) : null}
      </AnimatePresence>
      {controller.draftConflict ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1 text-og-xs text-og-status-failed">
          <span className="min-w-0 flex-1">{controller.messages.draftConflict}</span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void controller.resolveDraftConflict?.("use_remote")}
          >
            {controller.messages.useOtherDraft}
          </button>
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => void controller.resolveDraftConflict?.("keep_mine")}
          >
            {controller.messages.keepMine}
          </button>
        </div>
      ) : controller.draftSaving ? (
        <p className="px-1 pt-1 text-og-xs text-og-fg-subtle">{controller.messages.savingDraft}</p>
      ) : null}
    </>
  );
}

function ComposerAnnouncements() {
  const controller = useComposerController();
  return (
    <div className="sr-only">
      {controller.activeNotice ? (
        <p role={controller.activeNotice.tone === "error" ? "alert" : "status"}>
          {controller.activeNotice.message}
        </p>
      ) : null}
      {controller.draftConflict ? (
        <p role="alert">{controller.messages.draftConflict}</p>
      ) : controller.draftSaving ? (
        <p role="status">{controller.messages.savingDraft}</p>
      ) : null}
    </div>
  );
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}

function WorkstreamPausedStrip({
  control,
  queuedAheadCount,
  open,
  busy,
  sending,
  canControlWorkspace,
  controlLinks,
  messages,
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
  controlLinks: ComposerControlLinks | undefined;
  messages: ChatComposerMessages;
  onOpenChange: (open: boolean) => void;
  onResume: () => void;
  onResumeOption: (option: EffectiveSessionControl["resumeOptions"][number]) => void;
}) {
  const blocker = control.primaryBlocker;
  const cause =
    blocker?.kind === "workspace"
      ? messages.workspacePaused
      : control.directState === "paused"
        ? messages.pausedHere
        : messages.pausedBy(blocker?.displayName ?? messages.parentBlocker);
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
              ? messages.queuedAhead(queuedAheadCount)
              : sending
                ? messages.resumingAndSending
                : messages.nextMessageResumes}
          </span>
        </button>
        <button
          type="button"
          aria-label={messages.resumeThisWorkstream}
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-og-md border border-og-status-waiting/35 bg-og-surface-1 px-2.5 text-og-xs font-medium text-og-fg hover:bg-og-surface-2 pointer-coarse:min-h-11"
          disabled={busy}
          onClick={onResume}
        >
          {busy ? (
            <LoaderCircleIcon className="size-3.5 animate-og-spin" />
          ) : (
            <PlayIcon className="size-3.5 fill-current" />
          )}
          <span className="hidden min-[400px]:inline">{messages.resumeThisWorkstream}</span>
          <span className="min-[400px]:hidden">{messages.resumeShort}</span>
        </button>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-og-md text-og-fg-muted hover:bg-og-surface-2 pointer-coarse:size-11"
          onClick={() => onOpenChange(!open)}
          aria-label={open ? messages.hidePauseDetails : messages.showPauseDetails}
        >
          <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open ? (
        <div className="border-t border-og-status-waiting/20 px-3 pb-3 pt-2">
          <ul className="grid gap-2" aria-label={messages.pauseReasonsLabel}>
            {control.blockers.map((entry, index) => (
              <li
                key={`${entry.kind}-${entry.sessionId ?? "workspace"}-${entry.revision}`}
                className="text-og-xs"
              >
                <span className="font-medium text-og-fg">
                  {index === 0 ? messages.pausedByLabel : messages.alsoPausedByLabel}
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
                    · {messages.formatRelativeTime(entry.changedAt)}
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
                    {option.scope === "workspace"
                      ? messages.resumeWorkspace
                      : messages.resumeFromSession}
                  </span>
                  <span className="block text-[10px] text-og-fg-subtle">
                    {option.selectedStateAfter === "active"
                      ? messages.sessionCanRun
                      : messages.stillPausedBy(
                          option.remainingPrimaryBlocker?.displayName ?? messages.narrowerPause,
                        )}
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
  links: ComposerControlLinks | undefined,
): string | undefined {
  if (blocker.kind === "workspace") return links?.workspaceHref;
  return blocker.sessionId ? links?.sessionHref?.(blocker.sessionId) : undefined;
}

function RestoredResourceChips({
  resources,
  messages,
  onRemove,
}: {
  resources: ComposerState["restoredResources"];
  messages: ChatComposerMessages;
  onRemove: (index: number) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-1.5 border-b border-og-border px-3 py-2"
      aria-label={messages.restoredResourcesLabel}
    >
      {resources.map((resource, index) => (
        <span
          key={`${resource.kind}-${resource.kind === "file" ? resource.fileId : resource.uri}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-og-md border border-og-border bg-og-surface-2 px-2 py-1 text-og-xs text-og-fg-muted"
        >
          <FileIcon className="size-3 shrink-0" />
          <span className="truncate">
            {resource.kind === "file" ? messages.restoredFile(resource.fileId) : resource.uri}
          </span>
          <button
            type="button"
            className="shrink-0 hover:text-og-fg"
            onClick={() => onRemove(index)}
            aria-label={messages.removeRestoredResource(index)}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function ConfirmBar({
  command,
  messages,
  onCancel,
  onConfirm,
  returnFocusRef,
}: {
  command: SlashCommand;
  messages: ChatComposerMessages;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef?: RefObject<HTMLTextAreaElement | null> | undefined;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const descriptionId = useId();
  useEffect(() => {
    const returnTo = returnFocusRef?.current ?? null;
    confirmRef.current?.focus();
    return () => returnTo?.focus();
  }, [returnFocusRef]);
  return (
    <div
      role="alertdialog"
      aria-label={messages.confirmCommand(command.name)}
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
        {messages.confirmDescription(command)}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-og-md border border-og-border bg-og-surface-2 px-2.5 py-1 text-og-sm text-og-fg-muted hover:bg-og-surface-3 pointer-coarse:min-h-11"
        >
          {messages.cancel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="rounded-og-md border border-og-status-failed/50 bg-og-status-failed/15 px-2.5 py-1 text-og-sm text-og-status-failed hover:bg-og-status-failed/25 pointer-coarse:min-h-11"
        >
          {messages.runCommand(command.name)}
        </button>
      </span>
    </div>
  );
}

function AttachmentChips({
  attachments,
  messages,
  onRemove,
  onRetry,
}: {
  attachments: UseFileAttachmentsResult["attachments"];
  messages: ChatComposerMessages;
  onRemove: (id: string) => void;
  onRetry?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-og-border px-3 py-2">
      {attachments.map((attachment) => {
        const failed = attachment.status === "failed";
        const statusText =
          attachment.status === "uploading"
            ? messages.uploading
            : failed
              ? attachment.error || messages.uploadFailed
              : messages.formatBytes(attachment.sizeBytes);
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
                aria-label={messages.retryAttachment(attachment.name)}
                title={messages.retryUpload}
              >
                <RotateCwIcon className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className="shrink-0 rounded-og-xs p-1 text-og-fg-muted hover:bg-og-surface-1 hover:text-og-fg pointer-coarse:size-10"
              aria-label={messages.removeAttachment(attachment.name)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function HelpPanel({
  commands,
  messages,
  onClose,
}: {
  commands: readonly SlashCommand[];
  messages: ChatComposerMessages;
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
        <span className="text-og-sm font-medium text-og-fg">{messages.commands}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-og-xs text-og-fg-subtle hover:text-og-fg"
        >
          {messages.close}
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
                  {messages.danger}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}
