import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* ----------------------------------------------------------------------------
   ConfirmDialog — the one gate for destructive actions (doctrine D5).

   No bare trash icons that fire immediately: irreversible actions open this,
   with a title that names the object ("Delete environment 'staging'?"), a
   consequence sentence, and a destructive-styled confirm labeled with the
   verb + object ("Delete environment"), never "OK"/"Confirm". The typed-name
   Danger-zone pattern remains the higher bar for workspace deletion.
   -------------------------------------------------------------------------- */

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the object: "Delete environment 'staging'?" */
  title: ReactNode;
  /** One consequence sentence: what is lost, whether it can be undone. */
  description?: ReactNode;
  /** Optional extra content (e.g. an affected-items list). */
  children?: ReactNode;
  /** Verb + object: "Delete environment", "Revoke key". */
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * May be async; the dialog shows pending state while it runs. The dialog
   * closes on success — returning `false` (or throwing) keeps it open so a
   * failed mutation never reads as a completed one. Handlers that catch their
   * own errors (to toast) must return `false` on the failure path.
   */
  onConfirm: () => void | boolean | Promise<void | boolean>;
}) {
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      const result = await onConfirm();
      if (result !== false) {
        onOpenChange(false);
      }
    } catch {
      // The handler surfaces its own error (toast/notice); stay open for retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
