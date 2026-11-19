import { CreditCardIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/button";
import { userErrorText } from "../../ui/api-error";
import { startCardVerification, type CardVerificationClient } from "../lib/card-verification";
import { toast } from "../lib/toast";

/** The one action for a missing card: Stripe Checkout in setup mode, no
 * charge. Only the organization's owner adds its card. */
export function AddCardButton(props: {
  client: CardVerificationClient | null | undefined;
  accountId: string | null | undefined;
  variant?: "default" | "outline";
}) {
  const client = props.client;
  const [busy, setBusy] = useState(false);
  const [canVerify, setCanVerify] = useState<{ accountId: string; value: boolean } | null>(null);
  useEffect(() => {
    const accountId = props.accountId;
    if (!client || !accountId) return;
    let active = true;
    client
      .getBillingCardVerification({ accountId })
      .then((status) => {
        if (active) setCanVerify({ accountId, value: status.canVerify });
      })
      .catch(() => {
        // Unknown: offer the button; setup refuses a non-owner with a reason.
        if (active) setCanVerify({ accountId, value: true });
      });
    return () => {
      active = false;
    };
  }, [client, props.accountId]);
  const known = canVerify !== null && canVerify.accountId === props.accountId;
  if (!client || !props.accountId || (known && !canVerify.value)) {
    return <span className="text-sm text-fg-muted">Ask the organization owner to add a card.</span>;
  }
  const accountId = props.accountId;
  return (
    <Button
      type="button"
      size="sm"
      variant={props.variant ?? "default"}
      disabled={busy || !known}
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
