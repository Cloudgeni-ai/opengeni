import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { CheckIcon, CreditCardIcon, ExternalLinkIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { useOpenGeniText } from "../messages/runtime";
import type { PaymentPage } from "./payment-page";
import { ActivityDisclosure, BodyNote } from "./shared";

/**
 * How the chat checks a credits payment the person makes from a payment page
 * card. Without it the card still opens the page; it just can't confirm.
 */
export type PaymentPageActivity = {
  /** Where one credits checkout stands (GET /v1/billing/checkout/:id). */
  readCheckout?:
    | ((input: {
        checkoutSessionId: string;
        accountId?: string | undefined;
        signal: AbortSignal;
      }) => Promise<BillingCheckoutStatus>)
    | undefined;
  /** The checkout's credits reached the balance, so balances shown elsewhere refresh. */
  onCredited?: ((status: BillingCheckoutStatus) => void) | undefined;
};

const PaymentPageActions = createContext<PaymentPageActivity>({});

export function PaymentPageActivityProvider({
  children,
  ...actions
}: PaymentPageActivity & { children: ReactNode }) {
  return <PaymentPageActions.Provider value={actions}>{children}</PaymentPageActions.Provider>;
}

/** How often, and for how long after the page opens, the card checks for the payment. */
const POLL_MS = 2_000;
const POLL_FOR_MS = 30 * 60_000;

type Standing =
  | { state: "unknown" }
  | { state: "open" }
  | { state: "paid"; status: BillingCheckoutStatus }
  | { state: "expired" };

function standingOf(status: BillingCheckoutStatus): Standing {
  if (status.credit.state === "granted") return { state: "paid", status };
  if (status.status === "expired") return { state: "expired" };
  return { state: "open" };
}

function usd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    ...(Number.isInteger(amount) ? { maximumFractionDigits: 0 } : {}),
  }).format(amount);
}

/**
 * Watch one credits checkout: check once when shown and whenever the person
 * comes back to this tab, and every few seconds for a while after they open
 * the page, until its credits land or it expires.
 */
function useCheckoutStanding(page: PaymentPage, opened: number): Standing {
  const { readCheckout, onCredited } = useContext(PaymentPageActions);
  const [standing, setStanding] = useState<Standing>({ state: "unknown" });
  const settled = standing.state === "paid" || standing.state === "expired";
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;
  const { checkoutSessionId, accountId } = page;

  useEffect(() => {
    if (!readCheckout || !checkoutSessionId || settled) return;
    const controller = new AbortController();
    let busy = false;
    const check = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const status = await readCheckout({
          checkoutSessionId,
          accountId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const next = standingOf(status);
        setStanding(next);
        if (next.state === "paid") onCreditedRef.current?.(status);
      } catch {
        // A dropped read changes nothing; the next check tries again.
      } finally {
        busy = false;
      }
    };
    void check();
    const onReturn = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    const polling =
      opened > 0 && Date.now() - opened < POLL_FOR_MS
        ? setInterval(() => {
            if (Date.now() - opened >= POLL_FOR_MS) clearInterval(polling);
            else void check();
          }, POLL_MS)
        : undefined;
    return () => {
      controller.abort();
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      if (polling) clearInterval(polling);
    };
  }, [readCheckout, checkoutSessionId, accountId, settled, opened]);

  return standing;
}

/** A payment page an app action opened: one button that opens it, and for credits, the outcome. */
export function PaymentPageCard({ page }: { page: PaymentPage }) {
  const t = useOpenGeniText();
  const { readCheckout } = useContext(PaymentPageActions);
  const [opened, setOpened] = useState(0);
  const standing = useCheckoutStanding(page, opened);
  const amount = page.amountUsd !== undefined ? usd(page.amountUsd) : null;
  const confirmsHere = page.kind === "credits" && Boolean(page.checkoutSessionId && readCheckout);

  if (standing.state === "paid") {
    const added = usd(standing.status.credit.amountMicros / 1_000_000);
    const balance = standing.status.balance;
    return (
      // Its own row, so it starts closed and shows the balance.
      <ActivityDisclosure
        key="paid"
        icon={<CheckIcon className="size-3.5" />}
        iconTone="accent"
        title={
          standing.status.credit.free
            ? t("timeline.paymentPage.creditsGotFree", { amount: added })
            : t("timeline.paymentPage.creditsAdded", { amount: added })
        }
        preview={
          balance
            ? t("timeline.paymentPage.balanceNow", {
                balance: usd(balance.balanceMicros / 1_000_000),
              })
            : undefined
        }
        expandable={false}
      />
    );
  }

  const title =
    page.kind === "credits"
      ? amount
        ? t("timeline.paymentPage.payForCredits", { amount })
        : t("timeline.paymentPage.buyCredits")
      : page.kind === "subscription"
        ? t("timeline.paymentPage.subscribe")
        : t("timeline.paymentPage.billingPortal");
  const label =
    page.kind === "credits"
      ? amount
        ? t("timeline.paymentPage.payAmount", { amount })
        : t("timeline.paymentPage.pay")
      : page.kind === "subscription"
        ? t("timeline.paymentPage.continueToPayment")
        : t("timeline.paymentPage.openBilling");

  return (
    <ActivityDisclosure
      key="page"
      icon={<CreditCardIcon className="size-3.5" />}
      iconTone="accent"
      title={title}
      defaultOpen
    >
      {standing.state === "expired" ? (
        <BodyNote>{t("timeline.paymentPage.expired")}</BodyNote>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-0.5">
          <Button asChild size="sm">
            <a
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pointer-coarse:min-h-10"
              onClick={(event) => {
                event.stopPropagation();
                setOpened(Date.now());
              }}
            >
              {label}
              <ExternalLinkIcon className="size-3.5" aria-hidden />
            </a>
          </Button>
          <span className="text-og-sm leading-5 text-og-fg-muted">
            {confirmsHere
              ? opened > 0
                ? t("timeline.paymentPage.waitingForPayment")
                : t("timeline.paymentPage.opensSecurePageConfirms")
              : t("timeline.paymentPage.opensSecurePage")}
          </span>
        </div>
      )}
    </ActivityDisclosure>
  );
}
