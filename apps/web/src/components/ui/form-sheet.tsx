import { Dialog as DialogPrimitive } from "radix-ui";

import {
  FormDialogChromeProvider,
  FormFrame,
  useFormOverlay,
  type FormOverlayProps,
} from "@/components/ui/form-dialog";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   FormSheet - the form frame in a right sheet, for forms with more than four
   fields or that need room for a preview (brief 7.15). Same props and rules
   as FormDialog: title, one column, Cancel + one primary, errors inside.
   Full screen on phones. Slides in over 200ms; reduced motion skips it.
   -------------------------------------------------------------------------- */

export type FormSheetSize = "md" | "lg";

const SHEET_WIDTH: Record<FormSheetSize, string> = {
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[720px]",
};

export function FormSheet({
  open,
  onOpenChange,
  trigger,
  size = "md",
  dismissible,
  onCloseAutoFocus,
  onSubmitted,
  onCancel,
  onPendingChange,
  className,
  ...frame
}: FormOverlayProps & { size?: FormSheetSize }) {
  const overlay = useFormOverlay({
    open,
    onOpenChange,
    dismissible,
    pending: frame.pending,
    onSubmitted,
    onCancel,
    onPendingChange,
    onCloseAutoFocus,
    hasTrigger: Boolean(trigger),
  });
  return (
    <DialogPrimitive.Root {...overlay.rootProps}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none" />
        <DialogPrimitive.Content
          {...overlay.contentProps}
          {...(frame.description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-border bg-surface shadow-[var(--og-shadow-lg)] outline-none transition-transform duration-200 ease-out starting:translate-x-full motion-reduce:transition-none sm:border-l",
            SHEET_WIDTH[size],
          )}
        >
          <FormDialogChromeProvider>
            <FormFrame
              variant="sheet"
              {...frame}
              {...overlay.frameProps}
              className={cn("flex-1", className)}
            />
          </FormDialogChromeProvider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
