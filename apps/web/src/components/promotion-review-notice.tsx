import { Notice } from "@opengeni/react/ui/notice";
import type { BillingSummary } from "@opengeni/react/app/types";

type PromotionDecision = NonNullable<BillingSummary["balance"]>["promotionDecision"];

/** Public funding status only: never include private review evidence in the browser or email. */
export function PromotionReviewNotice({
  decision,
  accountId,
  supportEmail,
  banner = false,
}: {
  decision: PromotionDecision;
  accountId: string;
  supportEmail?: string | undefined;
  banner?: boolean;
}) {
  if (!decision || decision === "eligible") return null;
  const review = decision === "held" || decision === "denied";
  const href = supportEmail
    ? `mailto:${supportEmail}?subject=${encodeURIComponent("Request review of Free credit restriction")}&body=${encodeURIComponent(`Please review the Free credit restriction for my organization.\n\nOrganization reference: ${accountId}\n\nWhy I believe this may be a mistake:\n`)}`
    : null;
  return (
    <Notice
      tone="waiting"
      title={
        review ? "Free credit restricted · Review available" : "Free credit needs verification"
      }
      layout={banner ? "banner" : undefined}
      actionLayout="responsive"
      live="polite"
      className={banner ? "shrink-0" : undefined}
      action={
        href ? (
          <a
            href={href}
            className="inline-flex min-h-8 items-center text-sm font-medium og-link pointer-coarse:min-h-11"
          >
            Request review
          </a>
        ) : undefined
      }
    >
      {review
        ? "Free credit is restricted because repeated claims are suspected. This may be a mistake; you can request a review."
        : "Free credit is on hold until verification is complete. Contact support to request a review."}{" "}
      This review applies to Free credit; purchased credit is not part of the hold. You can still
      sign in and view your account.
      {!href ? " Ask your deployment administrator how to contact support." : null}
    </Notice>
  );
}
