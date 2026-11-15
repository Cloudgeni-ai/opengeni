import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { useAppContext } from "@opengeni/react/app/app-context";
import { useNavigate } from "@tanstack/react-router";
import { CreditCardIcon } from "lucide-react";

import { organizationSettingsAccess } from "@/lib/organization-settings-access";

/**
 * Opens Billing (plan, credits, receipts) for the current workspace's
 * organization, for people who can see it.
 */
export function BillingMenuItem({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const accountId = context.workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
  if (!accountId) return null;
  const access = organizationSettingsAccess({
    accessContext: context.accessContext,
    clientConfig: context.clientConfig,
    accountId,
  });
  if (!access.visibleSections.has("billing")) return null;
  return (
    <DropdownMenuItem
      className={className}
      onSelect={() =>
        void navigate({
          to: "/workspaces/$workspaceId/organization",
          params: { workspaceId },
          search: { section: "billing" },
        })
      }
    >
      <CreditCardIcon className="size-4" />
      Billing and receipts
    </DropdownMenuItem>
  );
}
