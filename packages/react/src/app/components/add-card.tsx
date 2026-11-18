import { CreditCardIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { userErrorText } from "../../ui/api-error";
import { useAppContext, useOptionalAppContext } from "../app-context";
import {
  CARD_REQUIRED_EVENT,
  CARD_RETURN_QUERY,
  noteCardVerified,
  readCardVerificationReturn,
  startCardVerification,
  type CardRequiredDetail,
} from "../lib/card-verification";
import { usePage } from "../lib/navigation";
import { hasAccountPermission } from "../lib/permissions";
import { toast } from "../lib/toast";
import type { AccessContext } from "../types";

/** The one action for a missing card: Stripe Checkout in setup mode, no charge. */
export function AddCardButton(props: {
  accountId: string | null | undefined;
  canManage: boolean;
  variant?: "default" | "outline";
}) {
  const client = useOptionalAppContext()?.client;
  const [busy, setBusy] = useState(false);
  if (!client || !props.accountId || !props.canManage) {
    return <span className="text-sm text-fg-muted">Ask the organization owner to add a card.</span>;
  }
  const accountId = props.accountId;
  return (
    <Button
      type="button"
      size="sm"
      variant={props.variant ?? "default"}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        startCardVerification(client, accountId).catch((error: unknown) => {
          setBusy(false);
          toast.error("Couldn't add a card", { description: userErrorText(error) });
        });
      }}
    >
      {busy ? (
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <CreditCardIcon className="size-4" aria-hidden="true" />
      )}
      Add a card
    </Button>
  );
}

/**
 * Mounted once beside the routes (with CreditRequiredGate): asks for a card
 * when a surface is refused for one, and confirms the card when checkout
 * returns to this page.
 */
export function CardRequiredGate(props: { accessContext: AccessContext | null }) {
  const [required, setRequired] = useState<CardRequiredDetail | null>(null);
  const workspaces = useAppContext().workspaces;
  useCardVerificationReturn();
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<CardRequiredDetail>).detail;
      if (detail?.workspaceId) setRequired(detail);
    };
    window.addEventListener(CARD_REQUIRED_EVENT, listener);
    return () => window.removeEventListener(CARD_REQUIRED_EVENT, listener);
  }, []);
  if (!required) return null;
  const accountId =
    required.accountId ??
    workspaces.find((workspace) => workspace.id === required.workspaceId)?.accountId ??
    null;
  const canManage = Boolean(
    accountId && hasAccountPermission(props.accessContext, accountId, "billing:manage"),
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : setRequired(null))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a card</DialogTitle>
          <DialogDescription>
            Sandboxes on the Free plan need a verified card. You won't be charged.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <AddCardButton accountId={accountId} canManage={canManage} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useCardVerificationReturn(): void {
  const page = usePage();
  const client = useAppContext().client;
  const [query] = useState(() => page.readQuery());
  useEffect(() => {
    if (!query.has(CARD_RETURN_QUERY.outcome)) return;
    const returned = readCardVerificationReturn(query);
    const current = page.readQuery();
    for (const key of Object.values(CARD_RETURN_QUERY)) current.delete(key);
    page.replaceQuery(current, { keepHistoryState: true });
    if (returned?.outcome !== "success") return;
    client
      .confirmBillingCardVerification({
        accountId: returned.accountId,
        checkoutSessionId: returned.checkoutSessionId,
      })
      .then((status) => {
        if (!status.verified) return;
        toast.success("Card added");
        noteCardVerified();
      })
      .catch((error: unknown) => {
        toast.error("Couldn't verify the card", { description: userErrorText(error) });
      });
    // Once per mount: the return is in the address the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
