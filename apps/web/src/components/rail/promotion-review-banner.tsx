import { useAppContext } from "@opengeni/react/app/app-context";
import { authorizedWorkspaceFromList } from "@opengeni/react/app/lib/workspace-scope-context";
import { useOpenGeniCredits } from "@/lib/opengeni-credits";
import { useShowPurchasePrompts } from "@opengeni/react/app/lib/purchase-presentation";
import { PromotionReviewNotice } from "@/components/promotion-review-notice";

/** Reuses the current organization's permission-gated billing read, never an organization inventory. */
export function PromotionReviewBanner({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const showPurchasePrompts = useShowPurchasePrompts();
  const workspace = authorizedWorkspaceFromList({
    workspaceId,
    workspaces: context.workspaces,
    accessContext: context.accessContext,
  });
  const accountId = showPurchasePrompts ? (workspace?.accountId ?? undefined) : undefined;
  const credits = useOpenGeniCredits(accountId);
  if (!accountId) return null;
  return (
    <PromotionReviewNotice
      banner
      decision={credits.promotionDecision}
      accountId={accountId}
      supportEmail={context.clientConfig.supportEmail}
    />
  );
}
