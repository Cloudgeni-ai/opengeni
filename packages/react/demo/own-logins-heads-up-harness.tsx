// Preview harness: the production chat composer with the owner's own-logins
// heads-up in its header, as a chat shared with the workspace shows it, styled
// by the web app's own stylesheet. Sample accounts only; Stop resolves locally
// and nothing reaches an API.
//   ?theme=light|dark   ?logins=one|many
//   ?desktop=macos  the desktop app's document mode (the page under its window bar)
//   many: Gmail connected twice for the same account (the duplicate case),
//         plus Slack and Atlassian.
import type { ConnectionMetadata } from "@opengeni/sdk";
import { ChatComposer, type ComposerState } from "@opengeni/react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  OwnLoginsSharedHeadsUp,
  ownLoginsInUse,
} from "@opengeni/react/app/components/capabilities/own-logins-shared-heads-up";
import type { ConnectedAccountGroup } from "@opengeni/react/app/components/capabilities/session-connection-accounts";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") !== "light";
const one = params.get("logins") === "one";
// Themed like the app: the whole document (lib/appearance.tsx), not a subtree.
document.documentElement.dataset.ogTheme = dark ? "dark" : "light";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
// The desktop app marks the document the same way (lib/desktop.tsx).
if (params.get("desktop") === "macos") document.documentElement.dataset.desktop = "macos";

const SUBJECT = "user:preview";

function connection(
  provider: string,
  metadata: Record<string, unknown>,
  grant: string,
): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: "account",
    workspaceId: "personal",
    authorityId: crypto.randomUUID(),
    subjectId: SUBJECT,
    providerDomain: provider,
    kind: "oauth2",
    status: "active",
    metadata,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    createdBySubjectId: SUBJECT,
    updatedBySubjectId: SUBJECT,
    createdAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    turnedOnHere: true,
    turnedOnHereGrantId: grant,
  };
}

const gmail = { email: "bendik@cloudgeni.ai" };
const initialGroups: ConnectedAccountGroup[] = one
  ? [{ serverId: "gmail", name: "Gmail", accounts: [connection("gmail.com", gmail, "g1")] }]
  : [
      {
        serverId: "gmail",
        name: "Gmail",
        // Connected twice: two connections for one Google account.
        accounts: [connection("gmail.com", gmail, "g1"), connection("gmail.com", gmail, "g2")],
      },
      {
        serverId: "slack",
        name: "Slack",
        accounts: [
          connection("slack.com", { slackUserName: "bendik", slackTeamName: "Cloudgeni" }, "s1"),
        ],
      },
      {
        serverId: "atlassian",
        name: "Atlassian (v1)",
        accounts: [connection("atlassian.com", { atlassianEmail: "bendik@cloudgeni.ai" }, "a1")],
      },
    ];

function Preview() {
  const [groups, setGroups] = useState(initialGroups);
  const [value, setValue] = useState("");
  const composer = useMemo<ComposerState>(
    () => ({
      value,
      setValue,
      hasDraftContent: () => value.trim().length > 0,
      send: async () => true,
      steer: async () => true,
      sending: false,
      canSend: value.trim().length > 0,
      pause: async () => {},
      pausing: false,
      resume: async () => {},
      resumeScope: async () => {},
      resuming: false,
      draft: null,
      draftRevision: 0,
      draftLoading: false,
      draftSaving: false,
      draftConflict: null,
      applyDraft: () => {},
      reloadDraft: async () => {},
      resolveDraftConflict: async () => {},
      restoredResources: [],
      removeRestoredResource: () => {},
      error: null,
      clearError: () => {},
    }),
    [value],
  );
  const logins = ownLoginsInUse(groups, {}, SUBJECT);
  // Stopping turns the login off here: it leaves the chat's accounts.
  const stop = async (stopped: readonly ConnectionMetadata[]) => {
    const ids = new Set(stopped.map((entry) => entry.id));
    setGroups((current) =>
      current.map((group) => ({
        ...group,
        accounts: group.accounts.filter((entry) => !ids.has(entry.id)),
      })),
    );
  };
  return (
    <div className="og-root flex h-screen flex-col bg-bg text-fg">
      <div className="min-h-0 flex-1" />
      <div className="shrink-0 px-4 pb-4" data-shot="">
        <div className="mx-auto w-full max-w-3xl">
          <ChatComposer
            responsiveBasis="container"
            composer={composer}
            placeholder="Send a follow-up…"
            transcription={{}}
            header={
              logins.length > 0 ? (
                <OwnLoginsSharedHeadsUp
                  logins={logins}
                  className="px-3.5 pt-2.5 md:px-4"
                  onStop={stop}
                />
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
