import { useEffect, useId, useState, type ReactNode, type RefObject } from "react";
import {
  BoxIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  FolderIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  UserIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { destructiveActionFocusTarget } from "@/components/ui/confirm-dialog";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog, FormFrame, type FormFrameProps } from "@/components/ui/form-dialog";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Destructive confirm (brief 7.16): make permanent actions explicit and
   blocked actions explainable. Builds on the FormDialog anatomy; the older
   ConfirmDialog stays for existing call sites.

   - "consequences" (default): the real name in the title, 2-4 bullets of
     what happens, what depends on it with links, and a destructive primary.
   - "type-to-confirm": the same, plus typing the name into an empty field.
     Only for permanent, wide-impact actions (a workspace, an org member).
   - "blocked": the action can't run. Says what blocks it, lists each
     dependency with a link, and offers only Close.

   Reversible actions skip the dialog: run them, then `showUndoToast`.
   -------------------------------------------------------------------------- */

export type DestructiveConfirmVariant = "consequences" | "type-to-confirm" | "blocked";

export type DependencyKind =
  | "schedule"
  | "chat"
  | "environment"
  | "workspace"
  | "variable-set"
  | "api-key"
  | "person";

const DEPENDENCY_ICON: Record<DependencyKind, LucideIcon> = {
  schedule: CalendarClockIcon,
  chat: MessageSquareIcon,
  environment: BoxIcon,
  workspace: FolderIcon,
  "variable-set": KeyRoundIcon,
  "api-key": KeyRoundIcon,
  person: UserIcon,
};

export interface ConfirmDependency {
  id: string;
  kind: DependencyKind;
  /** "Schedule", "Chat", "Sandbox environment default". */
  kindLabel: string;
  name: string;
  /** One quiet fact, for example "Every weekday at 08:00 · Oslo". */
  detail?: string;
  /** Where to fix it. Rendered as a link. */
  href?: string;
}

export interface DestructiveConfirmContentProps {
  variant?: DestructiveConfirmVariant;
  /** Names the real object: "Delete AWS production?" or, when blocked, "AWS production is in use". */
  title: ReactNode;
  /** One optional sentence under the title. */
  description?: ReactNode;
  /** 2-4 short bullets of what happens. End with "This can't be undone." when true. */
  consequences?: ReactNode[];
  /** What depends on the object, with links. Required for "blocked". */
  dependencies?: ConfirmDependency[];
  /** Heading over the dependencies. Default "Used by". */
  dependenciesTitle?: ReactNode;
  /** The exact name to type ("type-to-confirm"). */
  confirmText?: string;
  /** Neutral placeholder for the typed name; never the name itself. */
  confirmPlaceholder?: string;
  /** Verb + object: "Delete variable set". */
  confirmLabel?: string;
  /** "Deleting…". */
  pendingLabel?: string;
  /** The only button when blocked. Default "Close". */
  closeLabel?: string;
  /** May be async. Throw (with a user-facing message) to show the error inside. */
  onConfirm?: () => void | boolean | Promise<void | boolean>;
  /** A server error, shown inside the dialog. */
  error?: ReactNode;
  /** Controlled typed text. */
  typedValue?: string;
  /** Initial typed text, for previews. The dialog always starts empty. */
  defaultTypedValue?: string;
  onTypedValueChange?: (value: string) => void;
  /** Controlled submitting state, for previews. */
  pending?: boolean;
}

/** True when the typed name matches exactly, ignoring surrounding spaces. */
export function confirmTextMatches(typed: string, expected: string): boolean {
  return expected.trim().length > 0 && typed.trim() === expected.trim();
}

function DependencyList({
  title,
  dependencies,
}: {
  title: ReactNode;
  dependencies: ConfirmDependency[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h3 id={headingId} className="text-xs font-medium text-fg-muted">
        {title}
      </h3>
      <ul className="mt-2 -mx-2 flex min-w-0 flex-col">
        {dependencies.map((dependency) => {
          const Icon = DEPENDENCY_ICON[dependency.kind];
          const content = (
            <>
              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-fg-muted">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm font-medium break-words text-fg">
                  {dependency.name}
                </span>
                <span className="block truncate text-xs leading-4.5 text-fg-muted">
                  {dependency.kindLabel}
                  {dependency.detail ? ` · ${dependency.detail}` : ""}
                </span>
              </span>
              {dependency.href ? (
                // A right chevron means "opens": the dependency's own page.
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-fg-subtle transition-colors duration-[120ms] group-hover:text-fg"
                />
              ) : null}
            </>
          );
          return (
            <li key={dependency.id} className="min-w-0">
              {dependency.href ? (
                <a
                  href={dependency.href}
                  className="group flex min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors duration-[120ms] hover:bg-surface-2 pointer-coarse:min-h-11"
                >
                  {content}
                </a>
              ) : (
                <div className="flex min-w-0 items-center gap-3 px-2 py-2">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Builds the frame props shared by the dialog and its static panel. */
function useDestructiveFrame({
  variant = "consequences",
  title,
  description,
  consequences = [],
  dependencies = [],
  dependenciesTitle = "Used by",
  confirmText = "",
  confirmPlaceholder = "Type the name",
  confirmLabel = "Delete",
  pendingLabel = "Deleting…",
  closeLabel = "Close",
  onConfirm,
  error,
  typedValue,
  defaultTypedValue = "",
  onTypedValueChange,
  pending,
  open,
}: DestructiveConfirmContentProps & { open?: boolean }): Omit<FormFrameProps, "variant"> {
  const [ownTyped, setOwnTyped] = useState(defaultTypedValue);
  const typed = typedValue ?? ownTyped;
  const setTyped = (value: string) => {
    setOwnTyped(value);
    onTypedValueChange?.(value);
  };

  // The typed name always starts empty when the dialog opens again.
  useEffect(() => {
    if (open) setOwnTyped("");
  }, [open]);

  const blocked = variant === "blocked";
  const needsTyping = variant === "type-to-confirm";
  const matches = !needsTyping || confirmTextMatches(typed, confirmText);

  const body = (
    <div className="flex min-w-0 flex-col gap-5">
      {!blocked && consequences.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-2">
          {consequences.map((line, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- static copy, never reordered
            <li key={index} className="flex min-w-0 items-start gap-2.5 text-sm text-fg">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-fg-subtle" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {dependencies.length > 0 ? (
        <DependencyList title={dependenciesTitle} dependencies={dependencies} />
      ) : null}
      {needsTyping ? (
        <Field
          label={
            <>
              Type <span className="font-semibold break-all">{confirmText}</span> to confirm
            </>
          }
        >
          <TextInput
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={confirmPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
          />
        </Field>
      ) : null}
    </div>
  );

  if (blocked) {
    return {
      title,
      description,
      children: body,
      submitLabel: closeLabel,
      cancelLabel: null,
      showClose: false,
      footer: undefined,
    };
  }

  return {
    title,
    description,
    children: body,
    submitLabel: confirmLabel,
    pendingLabel,
    tone: "destructive",
    onSubmit: onConfirm,
    error,
    pending,
    submitDisabled: !matches,
    showClose: false,
    initialFocus: needsTyping ? "field" : "cancel",
  };
}

/** The destructive confirm in a modal. Focus starts on Cancel unless a name must be typed. */
export function DestructiveConfirm({
  open,
  onOpenChange,
  trigger,
  restoreFocusRef,
  restoreFocusFallbackRef,
  ...content
}: DestructiveConfirmContentProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  /** Where focus goes after closing when the trigger is gone (a deleted row). */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>;
}) {
  const frame = useDestructiveFrame({ ...content, open });
  const blocked = content.variant === "blocked";
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      size="sm"
      {...frame}
      onSubmitted={() => onOpenChange(false)}
      footer={
        blocked ? (
          <Button
            type="button"
            variant="outline"
            data-autofocus
            onClick={() => onOpenChange(false)}
            className="pointer-coarse:h-11"
          >
            {content.closeLabel ?? "Close"}
          </Button>
        ) : undefined
      }
      onCloseAutoFocus={
        restoreFocusRef || restoreFocusFallbackRef
          ? (event) => {
              const destination = destructiveActionFocusTarget(
                restoreFocusRef?.current ?? null,
                restoreFocusFallbackRef?.current ?? null,
              );
              if (!destination) return;
              event.preventDefault();
              destination.focus();
            }
          : undefined
      }
    />
  );
}

/**
 * The same content as a static panel, for previews and documentation. It is
 * exactly what the modal renders, without the overlay.
 */
export function DestructiveConfirmPanel({
  onClose,
  className,
  ...content
}: DestructiveConfirmContentProps & { onClose?: () => void; className?: string }) {
  const frame = useDestructiveFrame(content);
  const blocked = content.variant === "blocked";
  return (
    <FormFrame
      variant="dialog"
      {...frame}
      onCancel={onClose}
      onSubmitted={onClose}
      footer={
        blocked ? (
          <Button type="button" variant="outline" onClick={onClose} className="pointer-coarse:h-11">
            {content.closeLabel ?? "Close"}
          </Button>
        ) : undefined
      }
      className={cn("w-full max-w-[480px]", className)}
    />
  );
}

/* ----------------------------------------------------------------------------
   Undo instead of a dialog, for reversible actions (archive, remove from a list).
   -------------------------------------------------------------------------- */

export function UndoToast({
  title,
  description,
  undoLabel = "Undo",
  onUndo,
  onDismiss,
  icon,
  className,
}: {
  /** What just happened, past tense: "Archived 14 Sep checkout outage". */
  title: ReactNode;
  description?: ReactNode;
  undoLabel?: string;
  onUndo: () => void;
  onDismiss?: () => void;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="undo-toast"
      className={cn(
        "flex w-full max-w-[380px] min-w-0 items-center gap-3 rounded-lg border border-border bg-surface py-2.5 pr-2 pl-4 text-fg shadow-[var(--og-shadow-md)]",
        className,
      )}
    >
      {icon ? <span className="shrink-0 text-fg-subtle [&_svg]:size-4">{icon}</span> : null}
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-sm font-medium break-words text-fg">{title}</p>
        {description ? (
          <p className="truncate text-xs leading-4.5 text-fg-muted">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onUndo}
          className="px-2.5 font-semibold text-brand hover:text-brand pointer-coarse:h-11"
        >
          {undoLabel}
        </Button>
        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="text-fg-subtle hover:text-fg pointer-coarse:size-11"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Runs nothing itself: call it right after a reversible action. Undo calls
 * `onUndo` and closes the toast. Stays 8 seconds, longer than a normal toast.
 */
export function showUndoToast({
  title,
  description,
  undoLabel,
  onUndo,
  icon,
  duration = 8000,
}: {
  title: ReactNode;
  description?: ReactNode;
  undoLabel?: string;
  onUndo: () => void;
  icon?: ReactNode;
  duration?: number;
}): string | number {
  return toast.custom(
    (id) => (
      <UndoToast
        title={title}
        description={description}
        undoLabel={undoLabel}
        icon={icon}
        onUndo={() => {
          onUndo();
          toast.dismiss(id);
        }}
        onDismiss={() => toast.dismiss(id)}
      />
    ),
    { duration },
  );
}
