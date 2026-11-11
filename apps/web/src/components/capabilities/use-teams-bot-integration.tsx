import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { teamsApi, type TeamsBotStatus } from "@opengeni/sdk/teams";
import { useAppContext } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import type { IntegrationViewModel } from "@opengeni/react/app/components/capabilities/integration-view-model";
import type { IntegrationAdapter } from "./use-api-integration-accounts";
import { MICROSOFT_TEAMS_LOGO_URL } from "./use-microsoft-teams-integration";
import { IntegrationReachSection } from "./integration-reach-section";
import {
  clearTeamsFragment,
  savePendingTeamsLink,
  teamsErrorText,
  teamsFragmentToken,
} from "@/lib/teams-connect";

export function useTeamsBotIntegration({
  workspaceId,
  refreshRevision = 0,
}: {
  workspaceId: string;
  refreshRevision?: number;
}): IntegrationAdapter & { visible: boolean; sections: ReactNode } {
  const { client, accessContext, workspaces } = useAppContext();
  const api = useMemo(() => teamsApi(client, workspaceId), [client, workspaceId]);
  const scope = `${workspaceId}:${accessContext.subjectId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [loaded, setLoaded] = useState<{ scope: string; status: TeamsBotStatus } | null>(null);
  const status = loaded?.scope === scope ? loaded.status : null;
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  const [unlink, setUnlink] = useState(false);
  const [linkRequest, setLinkRequest] = useState<{ scope: string; token: string } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const canManage = hasWorkspacePermission(accessContext, workspaceId, "workspace:admin");

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await api.getBot(signal);
      if (currentScope.current !== scope) return;
      setLoaded({ scope, status: next });
      setError(null);
    },
    [api, scope],
  );

  useEffect(() => {
    const abort = new AbortController();
    setDisconnect(false);
    setUnlink(false);
    setLinkError(null);
    const captureLink = () => {
      const token = teamsFragmentToken(window.location.hash, "teams_link");
      setLinkRequest(token ? { scope, token } : null);
      setLinkError(null);
    };
    captureLink();
    window.addEventListener("hashchange", captureLink);
    void refresh(abort.signal).catch((caught) => {
      if (!abort.signal.aborted) setError({ scope, message: userErrorText(caught) });
    });
    return () => {
      abort.abort();
      window.removeEventListener("hashchange", captureLink);
    };
  }, [refresh, refreshRevision, scope]);

  const installed = status?.installation?.active === true;
  const paused = installed && (!status?.enabled || !status.configured);
  const deliveryNeedsAttention = Boolean(status?.delivery?.unknown || status?.delivery?.failed);
  const visible = Boolean(
    status?.installation ||
    (status?.enabled && status.configured) ||
    linkRequest?.scope === scope ||
    error?.scope === scope,
  );
  // The Teams app's own name, so this card matches the app people see in Teams.
  const appName = status?.appName ?? "Opengeni";
  const model: IntegrationViewModel = {
    id: "teams-bot",
    name: appName,
    description: "Start work with a channel mention or a private chat in Teams.",
    mark: { logoSrc: MICROSOFT_TEAMS_LOGO_URL, monogram: "MT" },
    chip:
      error?.scope === scope
        ? { label: "Unavailable", tone: "warn" }
        : !status
          ? { label: "Loading", tone: "plain" }
          : installed && (deliveryNeedsAttention || paused)
            ? { label: "Needs attention", tone: "warn" }
            : installed
              ? { label: "Connected", tone: "ok" }
              : { label: "Not connected", tone: "idle" },
    connection: installed
      ? [
          { label: "Bot", value: "Connected to this workspace" },
          { label: "Your account", value: status?.linked ? "Linked" : "Not linked" },
          ...(status?.delivery && deliveryNeedsAttention
            ? [
                {
                  label: "Replies needing attention",
                  value: String(status.delivery.unknown + status.delivery.failed),
                },
              ]
            : []),
        ]
      : [],
    outcomes: [],
    options: installed
      ? [
          {
            kind: "link",
            id: "teams-account-link",
            label: "Your Teams account",
            description: status?.linked
              ? "Your Teams messages use your Opengeni access."
              : `Message ${appName} in Teams to link your account.`,
            action: status?.linked
              ? { label: "Unlink account", onClick: () => setUnlink(true) }
              : {
                  label: "Open Teams",
                  onClick: () =>
                    window.open("https://teams.microsoft.com", "_blank", "noopener,noreferrer"),
                },
          },
        ]
      : [],
    footer:
      installed && canManage
        ? {
            kind: "actions",
            secondary: {
              label: "Disconnect bot",
              onClick: () => setDisconnect(true),
              destructive: true,
            },
          }
        : {
            kind: "locked",
            message: installed
              ? "A workspace administrator manages this bot."
              : canManage && status?.setupAvailable
                ? `Install the ${appName} app in Teams, then follow its setup link to connect this workspace.`
                : `Ask your administrator to set up ${appName} in Teams.`,
          },
    ...(deliveryNeedsAttention
      ? {
          notice: {
            tone: "waiting" as const,
            title: "Some Teams replies need attention",
            description:
              "Open the task link in Teams to see progress in Opengeni. Unconfirmed replies are not sent again.",
          },
        }
      : {}),
    ...(paused
      ? {
          notice: {
            tone: "waiting" as const,
            title: "Teams is unavailable here",
            description:
              "The bot cannot accept work right now. Ask your administrator to reconnect it.",
          },
        }
      : {}),
    ...(error?.scope === scope
      ? {
          notice: {
            tone: "failed" as const,
            title: "Couldn't load the Teams connection",
            description: error.message,
            action: {
              label: "Retry",
              onClick: () =>
                void refresh().catch((caught) =>
                  setError({ scope, message: userErrorText(caught) }),
                ),
            },
          },
        }
      : {}),
  };
  // With workspace routing, where people's Teams chats can start work; the
  // same control Slack uses to share its bot with the organization.
  const accountId = workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
  const reachVersion = useRef<number | undefined>(undefined);
  const sections =
    installed && status?.workspaceRouting && accountId ? (
      <IntegrationReachSection
        accountId={accountId}
        workspaceId={workspaceId}
        personalWorkspaces="choice"
        reloadKey={`${scope}:${status.installation?.tenantId ?? ""}`}
        load={async () => {
          const reach = await api.getReach();
          reachVersion.current = reach.version;
          return reach;
        }}
        save={async (next) => {
          const reach = await api.setReach(
            {
              workspaceIds: next.workspaceIds ? [...next.workspaceIds] : null,
              personalWorkspaces: next.personalWorkspaces,
            },
            reachVersion.current,
          );
          reachVersion.current = reach.version;
          return reach;
        }}
      />
    ) : null;
  return {
    visible,
    model,
    sections,
    dialogs: (
      <>
        <ConfirmDialog
          open={disconnect}
          onOpenChange={setDisconnect}
          title="Disconnect the Teams bot?"
          description="The bot will stop accepting work for this workspace. Existing chats remain. You can remove the app in Teams separately."
          confirmLabel="Disconnect bot"
          cancelAutoFocus
          onConfirm={async () => {
            try {
              await api.disconnectBot();
              await refresh();
              toast.success("Teams bot disconnected");
            } catch (caught) {
              toast.error("Couldn't disconnect Teams", { description: userErrorText(caught) });
              return false;
            }
          }}
        />
        <ConfirmDialog
          open={unlink}
          onOpenChange={setUnlink}
          title="Unlink your Teams account?"
          description="The bot will stop accepting work as you until you link your account again. Other people's account links remain."
          confirmLabel="Unlink account"
          cancelAutoFocus
          onConfirm={async () => {
            try {
              await api.unlinkAccount();
              await refresh();
              toast.success("Teams account unlinked");
            } catch (caught) {
              toast.error("Couldn't unlink Teams", { description: userErrorText(caught) });
              return false;
            }
          }}
        />
        <ConfirmDialog
          open={linkRequest?.scope === scope}
          destructive={false}
          onOpenChange={(open) => {
            if (!open) {
              setLinkRequest(null);
              clearTeamsFragment("teams_link");
            }
          }}
          title="Link your Teams account?"
          description="To confirm the Teams account is yours, sign in to Microsoft with the account you use in Teams. It's then linked to your signed-in Opengeni account, and the bot uses your access when you ask it to work."
          confirmLabel="Sign in with Microsoft"
          onConfirm={async () => {
            if (!linkRequest || linkRequest.scope !== scope) return false;
            try {
              // Microsoft returns to the setup page, which finishes the link.
              const { authorizationUrl } = await api.startLinkSignIn(linkRequest.token);
              savePendingTeamsLink({ linkToken: linkRequest.token, workspaceId });
              window.location.assign(authorizationUrl);
              return false;
            } catch (caught) {
              setLinkError(
                teamsErrorText(
                  caught,
                  "Get a new account link from Opengeni in Teams, then try again.",
                ),
              );
              return false;
            }
          }}
        >
          {linkError ? (
            <p role="alert" className="text-sm text-danger">
              {linkError}
            </p>
          ) : null}
        </ConfirmDialog>
      </>
    ),
  };
}
