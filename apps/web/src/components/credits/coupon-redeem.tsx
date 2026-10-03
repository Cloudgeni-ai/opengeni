import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { ArrowUpRightIcon, Loader2Icon, TicketIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { userErrorTextWithoutReference } from "@/lib/api-error";
import {
  openCheckoutTab,
  startCreditCheckout,
  waitForCheckoutCredits,
  type CreditCheckoutClient,
} from "@/lib/credit-checkout";

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; checkoutSessionId: string; url: string }
  | { kind: "failed"; message: string };

/**
 * "Have a coupon code?": the person types a code, Stripe Checkout opens in a
 * new tab with the code already applied (a fixed-amount code buys exactly its
 * amount, so a $100 code is $100 of credits for $0), and this page waits for
 * the credits to land before `onGranted` celebrates them. When the browser
 * blocks the tab, checkout takes over the page and organization billing
 * celebrates on return instead.
 */
export function CouponRedeem({
  client,
  accountId,
  workspaceId,
  onGranted,
  defaultOpen = false,
  disabled = false,
  variant = "stacked",
}: {
  client?: CreditCheckoutClient | undefined;
  accountId: string;
  /** Where a same-tab checkout returns (that workspace's organization billing). */
  workspaceId: string;
  onGranted: (status: BillingCheckoutStatus) => void;
  defaultOpen?: boolean;
  disabled?: boolean;
  /** "inline": just the field and Redeem, for a settings row; the label is for screen readers. */
  variant?: "stacked" | "inline";
}) {
  const inline = variant === "inline";
  const stayOpen = defaultOpen || inline;
  const [open, setOpen] = useState(defaultOpen || variant === "inline");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inputId = useId();
  const onGrantedRef = useRef(onGranted);
  onGrantedRef.current = onGranted;

  useEffect(() => {
    if (phase.kind !== "waiting" || !client) return;
    const controller = new AbortController();
    void waitForCheckoutCredits(client, {
      accountId,
      checkoutSessionId: phase.checkoutSessionId,
      signal: controller.signal,
    }).then(
      (status) => {
        if (status.credit.state === "granted") {
          setPhase({ kind: "idle" });
          setCode("");
          setOpen(stayOpen);
          onGrantedRef.current(status);
        } else {
          setPhase({
            kind: "failed",
            message: "That checkout expired before it finished. Try the code again.",
          });
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [accountId, client, phase, stayOpen]);

  async function redeem(): Promise<void> {
    const promotionCode = code.trim();
    if (!client || !promotionCode || phase.kind === "starting") return;
    // Open the tab before any await, or the browser treats it as a popup.
    const tab = openCheckoutTab();
    setPhase({ kind: "starting" });
    try {
      const started = await startCreditCheckout(client, {
        accountId,
        workspaceId,
        promotionCode,
        tab,
      });
      if (started.inNewTab) {
        setPhase({
          kind: "waiting",
          checkoutSessionId: started.checkoutSessionId,
          url: started.url,
        });
      }
    } catch (error) {
      setPhase({ kind: "failed", message: userErrorTextWithoutReference(error) });
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 text-fg-muted"
        disabled={disabled || !client}
        onClick={() => setOpen(true)}
      >
        <TicketIcon className="size-3.5" />
        Have a coupon code?
      </Button>
    );
  }

  if (phase.kind === "waiting") {
    return (
      <div
        role="status"
        className="grid gap-3 rounded-[10px] border border-border bg-surface-2 p-3 text-left"
      >
        <p className="flex items-start gap-2 text-sm text-fg">
          <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-fg-muted" />
          <span>
            Finish in the Stripe tab. Your credits show up here as soon as checkout is done.
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={phase.url} target="_blank" rel="noopener noreferrer">
              Open checkout again
              <ArrowUpRightIcon className="size-3.5" />
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const busy = phase.kind === "starting";
  return (
    <form
      className="grid gap-2 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        void redeem();
      }}
    >
      <label htmlFor={inputId} className={inline ? "sr-only" : "text-sm font-medium text-fg"}>
        Coupon code
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            if (phase.kind === "failed") setPhase({ kind: "idle" });
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={64}
          className="font-mono uppercase placeholder:font-sans placeholder:normal-case"
          placeholder="Enter your code"
          aria-invalid={phase.kind === "failed" || undefined}
          aria-describedby={`${inputId}-help`}
          autoFocus={!defaultOpen && !inline}
        />
        <Button
          type="submit"
          variant="outline"
          className="shrink-0"
          disabled={disabled || busy || !client || !code.trim()}
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Redeem
        </Button>
      </div>
      <p
        id={`${inputId}-help`}
        hidden={inline && phase.kind !== "failed"}
        role={phase.kind === "failed" ? "alert" : undefined}
        className={`text-xs leading-[18px] ${phase.kind === "failed" ? "text-danger" : "text-fg-muted"}`}
      >
        {phase.kind === "failed"
          ? phase.message
          : "Opens Stripe in a new tab with your code applied. Nothing is charged for a code that covers the full amount."}
      </p>
    </form>
  );
}
