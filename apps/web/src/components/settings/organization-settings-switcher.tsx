import { useNavigate } from "@tanstack/react-router";
import { Building2Icon, CheckIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ScopeSwitcherTrigger,
  SETTINGS_SWITCHER_CLASS,
} from "@/components/ui/scope-switcher-trigger";
import { useAppContext } from "@/context";
import { organizationsForSubject, organizationSettingsWorkspaceId } from "@/lib/org";
import type { OrganizationAdminSection } from "@/lib/organization-admin";

export function OrganizationSettingsSwitcher({
  workspaceId,
  organizationLabel,
  section,
}: {
  workspaceId: string;
  organizationLabel: string;
  section: OrganizationAdminSection;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const activeAccountId = context.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  )?.accountId;
  const organizations = organizationsForSubject(context.accessContext, context.workspaces);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ScopeSwitcherTrigger
          label={organizationLabel}
          icon={<Building2Icon aria-hidden="true" className="size-3.5" />}
          aria-label={`${organizationLabel}. Switch organization`}
          className={SETTINGS_SWITCHER_CLASS}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {organizations.map((organization) => {
          const target = organizationSettingsWorkspaceId(
            context.workspaces,
            organization.accountId,
            workspaceId,
          );
          const selected = organization.accountId === activeAccountId;
          return (
            <DropdownMenuItem
              key={organization.accountId}
              disabled={!target || !organization.canManage}
              aria-current={selected ? "true" : undefined}
              onSelect={() => {
                if (!target || !organization.canManage || selected) return;
                context.resetSessionView();
                void navigate({
                  to: "/workspaces/$workspaceId/organization",
                  params: { workspaceId: target },
                  search: { section },
                });
              }}
            >
              <Building2Icon aria-hidden="true" className="size-4" />
              <span className="min-w-0 flex-1 truncate" title={organization.label}>
                {organization.label}
              </span>
              {!target ? (
                <span className="text-2xs text-fg-subtle">No accessible workspace</span>
              ) : !organization.canManage ? (
                <span className="text-2xs text-fg-subtle">Admin access required</span>
              ) : null}
              {selected ? <CheckIcon aria-hidden="true" className="size-4 text-brand" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
