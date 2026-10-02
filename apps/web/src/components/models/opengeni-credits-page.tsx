import { OpengeniCreditsPanel } from "@/components/model-payment/opengeni-credits-panel";
import { OrganizationCreditBalance } from "@/components/organization-credit-balance";
import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { creditsPriceSentence } from "@/lib/model-payment";
import { useOrganizationCredits } from "@/lib/use-organization-credits";

/**
 * Organization > Models > Connect account > Opengeni credits: what credits
 * cost, the balance, and buying more, or the truthful reason it can't happen
 * here (no Stripe on this server; only an owner can buy).
 */
export function OpengeniCreditsPage({
  organizationId,
  organizationName,
  margin,
  backLabel,
  onBack,
  onOpenBilling,
}: {
  organizationId: string;
  organizationName: string;
  /** "5%": the markup on the provider's price. */
  margin: string | null;
  backLabel: string;
  onBack: () => void;
  /** Organization > Billing, for usage and invoices. */
  onOpenBilling?: (() => void) | undefined;
}) {
  const credits = useOrganizationCredits(organizationId);
  const here = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  return (
    <DetailPage back={{ label: backLabel, onClick: onBack }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        title="Opengeni credits"
        meta={
          <p className="m-0 text-sm text-fg-muted">
            {creditsPriceSentence(margin)} Credits belong to {organizationName} and pay for credit
            models in every workspace.
          </p>
        }
      />
      <div className="mt-6 grid max-w-[420px] min-w-0 gap-6" data-credits-page="">
        {credits.billingMode === "stripe" && credits.canRead ? (
          <OrganizationCreditBalance
            billing={
              credits.balance ? { mode: credits.billingMode, balance: credits.balance } : null
            }
            canReadBilling
            hasAccount
            loading={credits.loading}
            hasError={false}
          />
        ) : null}
        <OpengeniCreditsPanel
          credits={credits}
          organizationId={organizationId}
          margin={margin}
          showPrice={false}
          showBalance={false}
          successUrl={here}
          cancelUrl={here}
        />
        {onOpenBilling && credits.canRead && credits.billingMode === "stripe" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 justify-self-start"
            onClick={onOpenBilling}
          >
            Usage and invoices in Billing
          </Button>
        ) : null}
      </div>
    </DetailPage>
  );
}
