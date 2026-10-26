import type { BillingCheckoutStatus, OpenGeniClient } from "@opengeni/sdk";
import { CheckIcon, CreditCardIcon, ExternalLinkIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

/**
 * Set how payment page cards below check and report a payment. What this
 * provider leaves out comes from the one around it, so a host can add
 * `onCredited` around a chat that already checks payments itself.
 */
export function PaymentPageActivityProvider({
  children,
  readCheckout,
  onCredited,
}: PaymentPageActivity & { children: ReactNode }) {
  const outer = useContext(PaymentPageActions);
  const value = useMemo(
    () => ({
      readCheckout: readCheckout ?? outer.readCheckout,
      onCredited: onCredited ?? outer.onCredited,
    }),
    [readCheckout, onCredited, outer.readCheckout, outer.onCredited],
  );
  return <PaymentPageActions.Provider value={value}>{children}</PaymentPageActions.Provider>;
}

/**
 * A conversation's payment cards check payments through its own client
 * (the app's, or an embed's session proxy), unless a provider around the
 * conversation already says how. Clients without the billing read can't confirm.
 */
export function ClientPaymentPageActivity({
  client,
  children,
}: {
  client: unknown;
  children: ReactNode;
}) {
  const readCheckout = useMemo((): PaymentPageActivity["readCheckout"] => {
    const reader = client as Partial<Pick<OpenGeniClient, "getBillingCheckout">> | null;
    if (typeof reader?.getBillingCheckout !== "function") return undefined;
    return ({ checkoutSessionId, accountId }) =>
      reader.getBillingCheckout!(checkoutSessionId, accountId ? { accountId } : {});
  }, [client]);
  const outer = useContext(PaymentPageActions);
  return (
    <PaymentPageActivityProvider readCheckout={outer.readCheckout ?? readCheckout}>
      {children}
    </PaymentPageActivityProvider>
  );
}

/*
 * Checking a payment. Nothing is read before the person opens the page. After
 * that the card checks every 2 s for a minute, then every 15 s, for up to 30
 * minutes, and once whenever they come back to this tab. Stripe has no
 * "cancelled" state, so coming back to a page still open means they didn't
 * pay (yet): the regular checks stop, and the next return checks again. A
 * card opened earlier in this browser checks once when it's shown again.
 */
const FAST_CHECK_MS = 2_000;
const FAST_FOR_MS = 60_000;
const SLOW_CHECK_MS = 15_000;
const CHECK_FOR_MS = 30 * 60_000;

/** How long until the next regular check, this long after the page opened; null once it's time to stop. */
export function nextPaymentCheckDelay(sinceOpened: number): number | null {
  if (sinceOpened >= CHECK_FOR_MS) return null;
  return sinceOpened < FAST_FOR_MS ? FAST_CHECK_MS : SLOW_CHECK_MS;
}

/*
 * How long a link works when nobody opened it here. Stripe Checkout expires a
 * day after it's created; a billing portal link, five minutes after it's
 * created unless it's being used.
 */
const CHECKOUT_LINK_MS = 24 * 60 * 60_000;
const PORTAL_LINK_MS = 5 * 60_000;

const OPENED_STORAGE_KEY = "opengeni.paymentPagesOpened.v1";
const OPENED_KEEP_MS = 7 * 24 * 60 * 60_000;
const OPENED_KEEP_COUNT = 50;

function openedPages(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(OPENED_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

/** When this browser opened the checkout's page, or 0. */
function openedAt(checkoutSessionId: string | undefined): number {
  if (!checkoutSessionId || typeof window === "undefined") return 0;
  return openedPages()[checkoutSessionId] ?? 0;
}

function rememberOpened(checkoutSessionId: string, at: number): void {
  try {
    const kept = Object.entries({ ...openedPages(), [checkoutSessionId]: at })
      .filter(([, when]) => at - when < OPENED_KEEP_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, OPENED_KEEP_COUNT);
    window.localStorage.setItem(OPENED_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or off: only a reload forgets the page was opened.
  }
}

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
 * Watch one credits checkout once its page was opened (`opened`, ms since
 * epoch, or 0): see the timing above. `openedHere` is false for a page opened
 * before this card was shown, which checks once.
 */
function useCheckoutStanding(page: PaymentPage, opened: number, openedHere: boolean): Standing {
  const { readCheckout, onCredited } = useContext(PaymentPageActions);
  const [standing, setStanding] = useState<Standing>({ state: "unknown" });
  const settled = standing.state === "paid" || standing.state === "expired";
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;
  const { checkoutSessionId, accountId } = page;

  useEffect(() => {
    if (!readCheckout || !checkoutSessionId || settled || opened === 0) return;
    const controller = new AbortController();
    let busy = false;
    let regular = openedHere;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      const delay = regular ? nextPaymentCheckDelay(Date.now() - opened) : null;
      if (delay !== null) timer = setTimeout(() => void check(false), delay);
    };
    const check = async (returned: boolean) => {
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
        // Paid, credits on their way: keep checking until they land.
        if (status.status === "complete") regular = true;
        // Back here with the page still open: they cancelled or left it.
        else if (returned) regular = false;
      } catch {
        // A dropped read changes nothing; the next check tries again.
      } finally {
        busy = false;
        if (!controller.signal.aborted) schedule();
      }
    };
    if (openedHere) schedule();
    else void check(false);
    const onReturn = () => {
      if (document.visibilityState === "visible") void check(true);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [readCheckout, checkoutSessionId, accountId, settled, opened, openedHere]);

  return standing;
}

/** Whether a page nobody opened here has outlived its link; flips when it does. */
function useLinkExpired(page: PaymentPage, opened: number): boolean {
  const lifetime =
    opened > 0 || page.createdAt === undefined
      ? undefined
      : page.kind === "portal"
        ? PORTAL_LINK_MS
        : CHECKOUT_LINK_MS;
  const expiresAt = lifetime === undefined ? undefined : page.createdAt! + lifetime;
  const [now, setNow] = useState(() => Date.now());
  const expired = expiresAt !== undefined && now >= expiresAt;
  useEffect(() => {
    if (expiresAt === undefined || expired) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, expired]);
  return expired;
}

/** A payment page an app action opened: one button that opens it, and for credits, the outcome. */
export function PaymentPageCard({ page }: { page: PaymentPage }) {
  const t = useOpenGeniText();
  const { readCheckout } = useContext(PaymentPageActions);
  const watched = page.kind === "credits" ? page.checkoutSessionId : undefined;
  const [opened, setOpened] = useState(() => openedAt(watched));
  const [openedHere, setOpenedHere] = useState(false);
  const standing = useCheckoutStanding(page, opened, openedHere);
  const linkExpired = useLinkExpired(page, opened);
  const amount = page.amountUsd !== undefined ? usd(page.amountUsd) : null;
  const confirmsHere = Boolean(watched && readCheckout);

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
  const hint =
    page.kind === "portal"
      ? t("timeline.paymentPage.opensBillingPage")
      : confirmsHere
        ? opened > 0
          ? t("timeline.paymentPage.waitingForPayment")
          : t("timeline.paymentPage.opensSecurePageConfirms")
        : t("timeline.paymentPage.opensSecurePage");

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
      ) : linkExpired ? (
        <BodyNote>{t("timeline.paymentPage.linkExpired")}</BodyNote>
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
                const now = Date.now();
                if (watched) rememberOpened(watched, now);
                setOpened(now);
                setOpenedHere(true);
              }}
            >
              {label}
              <ExternalLinkIcon className="size-3.5" aria-hidden />
            </a>
          </Button>
          <span className="text-og-sm leading-5 text-og-fg-muted">{hint}</span>
        </div>
      )}
    </ActivityDisclosure>
  );
}
