import * as React from "react";
import { Dialog, Slot } from "radix-ui";

const DialogModalContext = React.createContext(true);

// Radix drops its Overlay in non-modal mode. Track the same flag for the
// composed content so it can still portal directly without a backdrop.
export function DialogModalRoot(props: React.ComponentPropsWithoutRef<typeof Dialog.Root>) {
  return (
    <DialogModalContext.Provider value={props.modal ?? true}>
      <Dialog.Root {...props} />
    </DialogModalContext.Provider>
  );
}

export function useDialogModal() {
  return React.useContext(DialogModalContext);
}

type OverlayProps = React.ComponentPropsWithoutRef<typeof Dialog.Overlay>;

/** Keep the backdrop and content in one stacking context, even in a body portal. */
export const ModalLayer = /* @__PURE__ */ React.forwardRef<
  React.ComponentRef<typeof Dialog.Overlay>,
  OverlayProps & {
    overlay?: React.ComponentType<OverlayProps & React.RefAttributes<HTMLDivElement>>;
    modal?: boolean;
  }
>(function ModalLayer({ overlay: Overlay = Dialog.Overlay, modal = true, ...props }, ref) {
  // Forward the portal's presence ref to Content even without a backdrop.
  if (!modal) return <Slot.Root ref={ref}>{props.children}</Slot.Root>;
  return <Overlay {...props} ref={ref} />;
});
