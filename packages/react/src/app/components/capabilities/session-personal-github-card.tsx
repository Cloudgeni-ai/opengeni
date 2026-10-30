import { personalGitHubSetupPath } from "@opengeni/contracts/personal-github";
import { useEffect, useRef, useState } from "react";

import type { AuthNeededItem } from "../../../timeline";
import { Button } from "../../../ui/button";
import { SessionCapabilityFrame } from "../../../components/session-capability-frame";
import { useAppContext } from "../../app-context";
import { usePage } from "../../lib/navigation";
import { hasWorkspacePermission } from "../../lib/permissions";
import { FIRST_PARTY_CAPABILITY_LOGOS } from "./capability-logo-source";

export type SessionPersonalGitHubCapabilityCardProps = {
  item: AuthNeededItem;
  workspaceId: string;
};

export const PERSONAL_GITHUB_CARD_DESCRIPTION =
  "Work appears under your name. Only in chats you start, on repos you choose.";

function repoCount(count: number): string {
  return count === 1 ? "1 repo" : `${count} repos`;
}

/**
 * The card the agent posts for "connect my GitHub": one step at a time,
 * Connect on GitHub, then choose the repos Opengeni may use as you.
 */
export function SessionPersonalGitHubCapabilityCard({
  item,
  workspaceId,
}: SessionPersonalGitHubCapabilityCardProps) {
  const context = useAppContext();
  const page = usePage();
  const [starting, setStarting] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const status = context.personalGitHubStatus;
  const refreshPersonalGitHub = context.refreshPersonalGitHub;
  const readOnce = useRef(false);
  useEffect(() => {
    if (readOnce.current || status !== null) return;
    readOnce.current = true;
    void refreshPersonalGitHub(workspaceId);
  }, [refreshPersonalGitHub, status, workspaceId]);

  const accessKnown = context.accessContext !== null && context.accessContext !== undefined;
  const canConnect =
    !accessKnown || hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const connection = status?.connection ?? null;
  const connected = connection?.status === "active";
  const needsReconnect = connection !== null && !connected && connection.status !== "revoked";
  const login =
    typeof connection?.metadata.githubLogin === "string" ? connection.metadata.githubLogin : null;
  const count = context.personalGitHubSelection?.repositories.length ?? 0;
  const chooseRepos = () => page.assign(personalGitHubSetupPath(workspaceId));
  const connect = () => {
    if (starting) return;
    setStarting(true);
    const begin = needsReconnect
      ? context.reconnectPersonalGitHub(workspaceId)
      : context.connectPersonalGitHub(workspaceId);
    // Success leaves the page for GitHub; a failure toasts and the card stays.
    void begin.finally(() => setStarting(false));
  };

  const actionUnavailable =
    status !== null && !status.enabled
      ? "Your GitHub isn't available on this deployment."
      : !canConnect
        ? "Your access doesn't allow connecting accounts in this workspace."
        : null;
  const loginLabel = login ? `@${login}` : "your account";

  return (
    <SessionCapabilityFrame
      name="Your GitHub"
      subtitle="GitHub"
      logo={FIRST_PARTY_CAPABILITY_LOGOS["api:github-app"] ?? null}
      typeLabel="Account"
      description={
        connected
          ? count === 0
            ? `Connected as ${loginLabel}. Choose the repos Opengeni may use as you.`
            : PERSONAL_GITHUB_CARD_DESCRIPTION
          : (item.capability?.rationale ?? PERSONAL_GITHUB_CARD_DESCRIPTION)
      }
      clampDescription={!connected && Boolean(item.capability?.rationale)}
      skill={false}
      expanded={false}
      complete={connected && count > 0}
      completeLabel={`Connected as ${loginLabel} · ${repoCount(count)}`}
      actionLabel={
        connected
          ? "Choose repos"
          : starting
            ? "Opening GitHub…"
            : needsReconnect
              ? "Reconnect"
              : "Connect your GitHub"
      }
      busy={starting}
      opensDialog={false}
      actionUnavailable={actionUnavailable}
      note=""
      onOpen={connected ? chooseRepos : connect}
      onClose={() => {}}
      opener={opener}
      cardRef={cardRef}
      details={
        connected && count > 0 ? (
          <div
            data-slot="personal-github-repos"
            className="border-t border-border px-[19px] pt-3 pb-4 max-[480px]:px-3.5"
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-[10px] pointer-coarse:h-11"
              onClick={chooseRepos}
            >
              Choose repos
            </Button>
          </div>
        ) : null
      }
    />
  );
}
