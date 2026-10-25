import { ArrowLeftIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/button";
import { containedPortal } from "../../../ui/portal-container";

const DialogContainedPortal = containedPortal(Dialog.Portal);

/**
 * The whole-window layer an artifact expands into: a Radix dialog with the
 * desktop app's window-control clearance, so Escape closes the innermost layer
 * and focus returns to where it came from.
 */
export function ArtifactFullWindowDialog({
  onClose,
  children,
  ...content
}: {
  onClose: () => void;
  children: ReactNode;
} & Omit<ComponentPropsWithRef<typeof Dialog.Content>, "children" | "className">) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogContainedPortal>
        <Dialog.Content
          data-artifact-fullscreen
          aria-describedby={undefined}
          {...content}
          className="fixed inset-0 z-50 flex h-dvh w-dvw flex-col overflow-hidden bg-surface text-left text-fg outline-hidden"
        >
          {children}
        </Dialog.Content>
      </DialogContainedPortal>
    </Dialog.Root>
  );
}

/** The single bar across the top of a full-window artifact; it also drags the desktop window. */
export function ArtifactFullWindowBar({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-window-drag
      className={cn(
        "flex min-h-12 shrink-0 items-center border-b border-border/80 bg-surface/95",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * An artifact shown by itself across the whole window, with one bar: back to
 * its page, its name and its main action. It matches a Site's full screen,
 * including the desktop app's window-control clearance, so every artifact
 * expands the same way. A Radix dialog, so an image lightbox opened from it
 * stacks above it and Escape closes the innermost layer first.
 */
export function ArtifactFullView({
  title,
  actions,
  onBack,
  children,
}: {
  title: string;
  actions?: ReactNode | undefined;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <ArtifactFullWindowDialog onClose={onBack} onOpenAutoFocus={(event) => event.preventDefault()}>
      <ArtifactFullWindowBar className="justify-between gap-3 px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 pointer-coarse:h-11"
            onClick={onBack}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Back
          </Button>
          <Dialog.Title className="truncate text-xs font-semibold">{title}</Dialog.Title>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </ArtifactFullWindowBar>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-surface-2 p-4 max-sm:p-2">
        <div className="m-auto w-full max-w-6xl min-w-0">{children}</div>
      </div>
    </ArtifactFullWindowDialog>
  );
}
