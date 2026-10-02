// Pinned account row: the account button (avatar and name, one target) and a
// Settings gear. Feedback, Help, Appearance and Sign out live in the account
// menu; the collapse toggle lives at the top of the rail with the wordmark.
// Collapsed, the avatar and the gear stack.
import { LockIcon, LogOutIcon, UserIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";

import { AppearanceSubmenu } from "@/components/appearance-menu";
import { HelpMenu } from "@/components/help-menu";
import {
  accountMenuAriaLabel,
  OrganizationInvitationsDialog,
  OrganizationInvitationsMenuItem,
  useOrganizationInvitations,
} from "@/components/organization-invitations";
import { AccountTrigger } from "@/components/rail/account-trigger";
import { useRail } from "@/components/rail/rail-context";
import { useNewOrganizationMenuItem } from "@/components/rail/switcher-block";
import { WorkspaceNav } from "@/components/rail/workspace-nav";
import { AccountUsageMenuItem } from "@/components/usage/usage-entry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import { hasWorkspacePermission } from "@/lib/permissions";

const FeedbackDialog = lazy(() =>
  import("@/components/feedback").then((module) => ({ default: module.FeedbackDialog })),
);

const BrowserAccountMenu = lazy(() =>
  import("@/components/browser-account-menu").then((module) => ({
    default: module.BrowserAccountMenu,
  })),
);

export function RailFooter() {
  const rail = useRail();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const context = useAppContext();
  const managed = context.clientConfig.auth.mode === "managedSession";
  const browserAccounts = managed && context.clientConfig.managedAuthSessionSetMode !== "legacy";
  const displayName =
    context.authSession?.user.name ??
    context.authSession?.user.email ??
    context.accessContext.subjectLabel ??
    context.accessContext.subjectId;
  const secondary = context.authSession?.user.email ?? context.accessContext.subjectId;
  const image = context.authSession?.user.image ?? undefined;
  const canSendFeedback = hasWorkspacePermission(
    context.accessContext,
    rail.workspaceId,
    "sessions:create",
  );
  const newOrganization = useNewOrganizationMenuItem();
  const organizationInvitations = useOrganizationInvitations({
    client: context.client,
    enabled: managed && !browserAccounts,
    activeEmail: context.authSession?.user.email ?? null,
    onUseInvitedAccount: () => {
      void context
        .handleManagedSignOut()
        .catch((error: unknown) =>
          toast.error("Couldn't sign out", { description: userErrorText(error) }),
        );
    },
    onAccepted: context.revalidatePrincipalAccess,
  });
  const onSendFeedback = canSendFeedback ? () => setFeedbackOpen(true) : undefined;

  return (
    <div className="mt-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {canSendFeedback ? (
        <Suspense fallback={null}>
          <FeedbackDialog
            key={rail.workspaceId}
            client={context.client}
            workspaceId={rail.workspaceId}
            open={feedbackOpen}
            onOpenChange={setFeedbackOpen}
            onSubmitted={() => toast.success("Thanks for your feedback")}
          />
        </Suspense>
      ) : null}
      <div
        className={rail.collapsed ? "grid justify-items-center gap-1" : "flex items-center gap-0.5"}
      >
        {browserAccounts ? (
          <div className={rail.collapsed ? undefined : "min-w-0 flex-1"}>
            <Suspense
              fallback={
                <AccountTrigger
                  collapsed={rail.collapsed}
                  displayName={displayName}
                  image={image}
                  aria-label="Loading account menu"
                  disabled
                />
              }
            >
              <BrowserAccountMenu onSendFeedback={onSendFeedback} />
            </Suspense>
          </div>
        ) : (
          <div className={rail.collapsed ? undefined : "min-w-0 flex-1"}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <AccountTrigger
                  collapsed={rail.collapsed}
                  displayName={displayName}
                  image={image}
                  pendingCount={organizationInvitations.pendingCount}
                  aria-label={accountMenuAriaLabel({
                    displayName,
                    pendingCount: organizationInvitations.pendingCount,
                  })}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side={rail.collapsed ? "right" : "top"}
                className="w-[min(16rem,calc(100vw-1rem))]"
              >
                <DropdownMenuLabel className="grid gap-0.5 pb-1.5">
                  <span className="truncate text-sm text-fg">{displayName}</span>
                  {secondary && secondary !== displayName ? (
                    <span className="truncate text-xs font-normal text-fg-muted">{secondary}</span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <AccountUsageMenuItem workspaceId={rail.workspaceId} />
                {managed ? (
                  <OrganizationInvitationsMenuItem controller={organizationInvitations} />
                ) : null}
                {newOrganization.item}
                {(managed && organizationInvitations.pendingCount > 0) || newOrganization.item ? (
                  <DropdownMenuSeparator />
                ) : null}
                <AppearanceSubmenu />
                <HelpMenu
                  documentationUrl={context.clientConfig.documentationUrl}
                  onSendFeedback={onSendFeedback}
                />
                <DropdownMenuSeparator />
                {managed ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      void context
                        .handleManagedSignOut()
                        .catch((error: unknown) =>
                          toast.error("Couldn't sign out", { description: userErrorText(error) }),
                        );
                    }}
                  >
                    <LogOutIcon />
                    Sign out
                  </DropdownMenuItem>
                ) : context.keyAuthRequired ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => context.forgetAccessKey()}
                  >
                    <LockIcon />
                    Clear access key
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled>
                    <UserIcon />
                    {context.accessContext.mode} access
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        <WorkspaceNav compact />
      </div>
      {managed && !browserAccounts ? (
        <OrganizationInvitationsDialog controller={organizationInvitations} />
      ) : null}
      {newOrganization.dialog}
    </div>
  );
}
