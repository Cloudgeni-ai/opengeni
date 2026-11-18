import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import type { CardVerificationClient } from "../lib/card-verification";
import { AddCardButton } from "./add-card-button";

/** Asks for a card when a sandbox was refused for one (lazy: see add-card.tsx). */
export function CardRequiredDialog(props: {
  client: CardVerificationClient | null | undefined;
  accountId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a card</DialogTitle>
          <DialogDescription>
            Sandboxes on the Free plan need a verified card. You won't be charged.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <AddCardButton client={props.client} accountId={props.accountId} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
