import type { CreditOffer } from "@opengeni/contracts";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@opengeni/react/app/app-context";
import { coveredModelsSummary } from "@opengeni/react/app/lib/credit-coverage";
import {
  CREDIT_BALANCE_CHANGED,
  notifyCreditBalanceChanged,
} from "@opengeni/react/app/lib/credit-balance-events";
import { formatMoneyMicros } from "@opengeni/react/app/lib/format";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** What an offer gives, for how long, and until when it can be activated. */
export function creditOfferDescription(offer: CreditOffer): string {
  return [
    `${formatMoneyMicros(offer.amountMicros, "usd")} for ${coveredModelsSummary(offer.eligibleModelIds)}`,
    `Lasts ${offer.validDays} ${offer.validDays === 1 ? "day" : "days"} from activation`,
    ...(offer.activateBy ? [`Activate by ${shortDate(offer.activateBy)}`] : []),
  ].join(" · ");
}

/**
 * Custom credit offers waiting for activation (docs/custom-credit-offers.md).
 * Active offers show in the balance with their expiry; nothing renders when
 * there is nothing to activate.
 */
export function CreditOffers({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const { client } = useAppContext();
  const [offers, setOffers] = useState<CreditOffer[]>([]);
  const [selfServe, setSelfServe] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await client.listCreditOffers({ accountId });
      setOffers(result.offers.filter((offer) => offer.status === "available"));
      setSelfServe(result.selfServeActivation);
    } catch {
      // Offers are optional: the balance and top-ups stay usable without them.
      setOffers([]);
    }
  }, [accountId, client]);
  useEffect(() => {
    void load();
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ accountId: string }>).detail.accountId === accountId) void load();
    };
    window.addEventListener(CREDIT_BALANCE_CHANGED, changed);
    return () => window.removeEventListener(CREDIT_BALANCE_CHANGED, changed);
  }, [accountId, load]);

  async function activate(offer: CreditOffer) {
    setActivating(offer.id);
    try {
      await client.activateCreditOffer(offer.id, { accountId });
      toast.success(`${offer.label} activated`);
      notifyCreditBalanceChanged(accountId);
    } catch (error) {
      toast.error("Couldn't activate the offer", { description: userErrorText(error) });
      void load();
    } finally {
      setActivating(null);
    }
  }

  if (offers.length === 0) return null;
  const canActivate = canManage && selfServe;
  return (
    <SettingRowGroup>
      {offers.map((offer) => (
        <SettingRow
          key={offer.id}
          label={offer.label}
          description={
            canActivate
              ? creditOfferDescription(offer)
              : `${creditOfferDescription(offer)} · ${
                  selfServe ? "An owner can activate it" : "Contact Opengeni support to activate it"
                }`
          }
          controlWidth="auto"
          control={
            canActivate ? (
              <RowButton disabled={activating !== null} onClick={() => void activate(offer)}>
                {activating === offer.id ? "Activating…" : "Activate"}
              </RowButton>
            ) : undefined
          }
        />
      ))}
    </SettingRowGroup>
  );
}
