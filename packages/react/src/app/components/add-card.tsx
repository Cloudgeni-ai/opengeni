import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { userErrorText } from "../../ui/api-error";
import { useAppContext } from "../app-context";
import {
  CARD_REQUIRED_EVENT,
  CARD_RETURN_QUERY,
  noteCardVerified,
  readCardVerificationReturn,
  type CardRequiredDetail,
} from "../lib/card-verification";
import { usePage } from "../lib/navigation";
import { toast } from "../lib/toast";

// The dialog and its card glyph load only when a card is asked for, so they
// stay out of the eager bundle.
const CardRequiredDialog = lazy(() =>
  import("./add-card-dialog").then((module) => ({ default: module.CardRequiredDialog })),
);

/**
 * Mounted once beside the routes (with CreditRequiredGate): asks for a card
 * when a surface is refused for one, and confirms the card when checkout
 * returns to this page.
 */
export function CardRequiredGate() {
  const [required, setRequired] = useState<CardRequiredDetail | null>(null);
  // Each workspace asks once per page: a viewer refused again does not
  // reopen the dialog (the session's banner keeps Add a card).
  const asked = useRef(new Set<string>());
  const { workspaces, client } = useAppContext();
  useCardVerificationReturn();
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<CardRequiredDetail>).detail;
      if (!detail?.workspaceId || asked.current.has(detail.workspaceId)) return;
      asked.current.add(detail.workspaceId);
      setRequired(detail);
    };
    window.addEventListener(CARD_REQUIRED_EVENT, listener);
    return () => window.removeEventListener(CARD_REQUIRED_EVENT, listener);
  }, []);
  if (!required) return null;
  const accountId =
    required.accountId ??
    workspaces.find((workspace) => workspace.id === required.workspaceId)?.accountId ??
    null;
  return (
    <Suspense fallback={null}>
      <CardRequiredDialog client={client} accountId={accountId} onClose={() => setRequired(null)} />
    </Suspense>
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
