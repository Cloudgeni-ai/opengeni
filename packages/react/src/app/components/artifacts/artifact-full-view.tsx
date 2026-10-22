import { ArrowLeftIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";

import { Button } from "../../../ui/button";
import { containedPortal } from "../../../ui/portal-container";

const DialogContainedPortal = containedPortal(Dialog.Portal);

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
    <Dialog.Root open onOpenChange={(open) => !open && onBack()}>
      <DialogContainedPortal>
        <Dialog.Content
          data-artifact-fullscreen
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="fixed inset-0 z-50 flex h-dvh w-dvw flex-col overflow-hidden bg-surface text-left text-fg outline-hidden"
        >
          <div
            data-window-drag
            className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-surface/95 px-3 sm:px-4"
          >
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
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-surface-2 p-4 max-sm:p-2">
            <div className="m-auto w-full max-w-6xl min-w-0">{children}</div>
          </div>
        </Dialog.Content>
      </DialogContainedPortal>
    </Dialog.Root>
  );
}
