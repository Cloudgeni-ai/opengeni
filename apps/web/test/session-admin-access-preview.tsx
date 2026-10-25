import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionAdminAccess } from "@opengeni/sdk";
import { AgentAdminAccessRow } from "../src/components/organization/security-page";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import type { SessionAdminAccessControl } from "@opengeni/react/app/components/session/session-admin-access";
import { Section } from "@opengeni/react/ui/section";
import type { Session } from "@opengeni/react/app/types";
import { SessionShellAppContext } from "./session-shell-app-context";
import "../src/styles.css";

// Production components and styles; synthetic organization, people and session.
const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";
const organizationId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";

let allowed = params.get("org") !== "off";
let chatActionsAllowed = params.get("chat") !== "off";
const client = {
  getOrganizationAgentAdminAccess: async () => ({
    organizationId,
    sessionAdminAccessAllowed: allowed,
    chatActionsAllowed,
  }),
  updateOrganizationAgentAdminAccess: async (
    _organizationId: string,
    request: { sessionAdminAccessAllowed?: boolean; chatActionsAllowed?: boolean },
  ) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    allowed = request.sessionAdminAccessAllowed ?? allowed;
    chatActionsAllowed = request.chatActionsAllowed ?? chatActionsAllowed;
    return { organizationId, sessionAdminAccessAllowed: allowed, chatActionsAllowed };
  },
} as unknown as OpenGeniBrowserClient;

const session = {
  id: "00000000-0000-4000-8000-000000000003",
  workspaceId,
  title: "Clean up connection settings across workspaces",
  initialMessage: "Clean up connection settings across workspaces",
  metadata: {},
  status: "idle",
  model: "preview/model",
  reasoningEffort: "medium",
  latencyMode: "standard",
  parentSessionId: null,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as unknown as Session;

function useControl(initialActive: boolean): SessionAdminAccessControl {
  const [state, setState] = useState<SessionAdminAccess>({
    active: initialActive,
    allowed: true,
    canGrant: true,
    canRevoke: true,
    grantedAt: initialActive ? "2026-10-01T09:00:00.000Z" : null,
    grantedBy: initialActive ? { subjectId: "user:preview", name: "Jordan Lee" } : null,
  });
  const [busy, setBusy] = useState(false);
  return {
    state,
    busy,
    grant: async () => {
      setBusy(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      setState((current) => ({
        ...current,
        active: true,
        grantedAt: new Date().toISOString(),
        grantedBy: { subjectId: "user:preview", name: "Jordan Lee" },
      }));
      setBusy(false);
    },
    revoke: () => {
      setState((current) => ({ ...current, active: false, grantedAt: null, grantedBy: null }));
    },
  };
}

function Header({ active, testId }: { active: boolean; testId: string }) {
  const control = useControl(active);
  return (
    <div data-testid={testId} className="rounded-md border border-border">
      <SessionShellAppContext>
        <SessionHeader
          session={session}
          ancestors={[]}
          connectionState="live"
          status={session.status}
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          adminAccess={control}
        />
      </SessionShellAppContext>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg p-4 text-fg sm:p-10">
    <div className="mx-auto flex max-w-5xl flex-col gap-10">
      <div>
        <p className="mb-6 text-sm text-fg-muted">Organization settings · Security & data</p>
        <Section title="Agents">
          <AgentAdminAccessRow
            client={client}
            identity={{
              principalGeneration: 1,
              subjectId: "user:preview",
              organizationId,
              workspaceId,
            }}
          />
        </Section>
      </div>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">Session header · full access on, then off</p>
        <Header active testId="header-on" />
        <Header active={false} testId="header-off" />
      </div>
    </div>
  </main>,
);
