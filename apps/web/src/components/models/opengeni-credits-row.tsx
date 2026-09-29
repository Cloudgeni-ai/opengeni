import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { ListRow } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { useAppContext } from "@/context";
import { formatMoneyMicros } from "@/lib/format";
import { modelUsesCredits } from "@/lib/model-policy";
import { hasAccountPermission } from "@/lib/permissions";
import { currentPageReturnTo, returnToSearch } from "@/lib/return-to";
import type { ClientConfig } from "@/types";

/* ----------------------------------------------------------------------------
   OpenGeni credits in Settings > Models: on a deployment that bills credits,
   the organization's credit balance pays for credit models, so it is the
   first row of the Accounts list. Billing admins open organization Billing
   from it; everyone else sees a plain row.
   -------------------------------------------------------------------------- */

/** This deployment bills OpenGeni credits: Stripe billing and at least one credit model. */
export function deploymentBillsCredits(config: Pick<ClientConfig, "billingMode" | "models">) {
  return config.billingMode === "stripe" && config.models.some((model) => modelUsesCredits(model));
}

export interface OpenGeniCredits {
  /** False on deployments without credits: no row, and credits don't count as a payer. */
  visible: boolean;
  /** "$12.40 left", "No credits left", or null while unknown or unreadable. */
  balanceLabel: string | null;
  /** Billing admins: the row opens organization Billing. */
  canOpenBilling: boolean;
}

export function useOpenGeniCredits(organizationId: string | undefined): OpenGeniCredits {
  const { client, clientConfig, accessContext } = useAppContext();
  const visible = deploymentBillsCredits(clientConfig) && Boolean(organizationId);
  const accountId = organizationId ?? "";
  const canManage = visible && hasAccountPermission(accessContext, accountId, "billing:manage");
  const canRead =
    visible && (canManage || hasAccountPermission(accessContext, accountId, "billing:read"));
  const [balanceLabel, setBalanceLabel] = useState<string | null>(null);
  useEffect(() => {
    setBalanceLabel(null);
    if (!canRead) return;
    let current = true;
    void client
      .getBilling({ accountId })
      .then((billing) => {
        if (!current || billing.mode !== "stripe") return;
        const { balanceMicros, currency } = billing.balance;
        setBalanceLabel(
          balanceMicros > 0
            ? `${formatMoneyMicros(balanceMicros, currency)} left`
            : "No credits left",
        );
      })
      // The balance is a detail: without it the row still says how credits pay.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, accountId, canRead]);
  return { visible, balanceLabel, canOpenBilling: canManage };
}

export function OpenGeniCreditsRow({
  credits,
  workspaceId,
  workspaceName,
}: {
  credits: OpenGeniCredits;
  workspaceId: string;
  workspaceName: string;
}) {
  const navigate = useNavigate();
  if (!credits.visible) return null;
  const openBilling = () =>
    void navigate({
      to: "/workspaces/$workspaceId/organization",
      params: { workspaceId },
      search: {
        section: "billing",
        ...returnToSearch(currentPageReturnTo(`${workspaceName} · Models`)),
      },
    });
  return (
    <ListRow
      leading={<LogoTile icon={<BrandMark className="text-fg" />} name="OpenGeni" />}
      title="OpenGeni credits"
      meta={["Pay as you go", credits.balanceLabel]}
      {...(credits.canOpenBilling ? { onOpen: openBilling, indicator: "open" as const } : {})}
    />
  );
}
