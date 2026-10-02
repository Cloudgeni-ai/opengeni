import { Link } from "@tanstack/react-router";

import { ModelPaymentChoice } from "@/components/model-payment/model-payment-choice";
import { useAppContext } from "@/context";
import {
  creditsMarginLabel,
  modelPaymentOptions,
  type ModelPaymentOption,
  type ModelPaymentOptionId,
} from "@/lib/model-payment";
import type { ModelsView } from "@/lib/models-route";
import { useOrganizationCredits } from "@/lib/use-organization-credits";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { administersOrganization } from "@/lib/workspaces";

const VIEWS: Record<ModelPaymentOptionId, ModelsView> = {
  credits: "credits",
  codex: "connect-org:codex",
  supergrok: "connect-org:supergrok",
  gateway: "connect-org:vercel",
  openrouter: "connect-org:openrouter",
};

/**
 * The composer's "Connect a model" menu when no model can run here: how to
 * pay for models, credits first, each row opening its page in Organization
 * settings > Models. The same options and words as onboarding; rows the
 * person can't use say why (no Stripe here, only an owner can buy, only an
 * owner or admin can connect).
 */
export function ModelPaymentMenu({ workspaceId }: { workspaceId: string }) {
  const { accessContext, clientConfig, workspaces } = useAppContext();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const organizationId = workspace?.accountId ?? accessContext.defaultAccountId ?? null;
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const credits = useOrganizationCredits(organizationId);
  const models = catalog.models.length > 0 ? catalog.models : clientConfig.models;
  const options = modelPaymentOptions({
    billingMode: credits.billingMode,
    canBuyCredits: credits.canBuy,
    canConnectAccounts: administersOrganization({
      accessContext,
      clientConfig,
      accountId: organizationId,
    }),
    codexEnabled: models.some((model) => model.source === "codex"),
    supergrokEnabled: models.some((model) => model.source === "supergrok"),
    balance: credits.balance,
    creditsMargin: creditsMarginLabel(catalog.models),
    lead: "credits",
  }).filter(
    // A subscription this server doesn't offer is not a choice here.
    (option) => option.featured || option.state !== "unavailable",
  );
  const link = (option: ModelPaymentOption) => ({
    kind: "link" as const,
    render: (row: React.ReactNode, className: string) => (
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId }}
        search={{ section: "models", view: VIEWS[option.id] } as never}
        className={className}
      >
        {row}
      </Link>
    ),
  });
  return (
    <div className="px-1.5 pt-2 pb-1.5" data-testid="model-picker-connect">
      <div className="px-1.5 pb-2">
        <p className="text-sm font-medium tracking-tight text-fg">Connect a model</p>
        <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
          Nothing pays for models here yet. Pick how.
        </p>
      </div>
      <ModelPaymentChoice options={options} density="compact" actionFor={link} />
    </div>
  );
}
