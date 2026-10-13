import { createRoot } from "react-dom/client";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { SessionTenancyControl } from "../src/components/session/session-tenancy-control";
import { SessionTenancyOperationController } from "../src/lib/session-tenancy-operation-controller";
import type { Session } from "../src/types";
import "../src/styles.css";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
// ?case=machine or ?case=sandbox renders a workspace-visible session that
// shares its box with a sibling, so "Limit to me" shows what stays shared.
const sharedBox = new URLSearchParams(location.search).get("case");
const sharedBoxSession: Partial<Session> | null =
  sharedBox === "machine" || sharedBox === "sandbox"
    ? {
        title: "Release checklist",
        sandboxBackend: sharedBox === "machine" ? "selfhosted" : "modal",
        sandboxGroupId: "55555555-5555-4555-8555-555555555555",
        tenancy: {
          visibility: "workspace",
          authorityEpoch: 1,
          ownedByCurrentUser: true,
          fork: null,
        },
      }
    : null;

function SessionTenancyControlFixture() {
  return (
    <main className="flex min-h-screen items-start justify-end p-6">
      <SessionTenancyControl
        session={
          {
            id: sessionId,
            workspaceId,
            accountId: "11111111-1111-4111-8111-111111111111",
            status: "idle",
            initialMessage: "Review the private workspace boundary",
            title: "Private workspace review",
            titleSource: "user",
            tenancy: {
              visibility: "private",
              authorityEpoch: 3,
              ownedByCurrentUser: true,
              fork: null,
            },
            ...sharedBoxSession,
          } as Session
        }
        client={{} as OpenGeniBrowserClient}
        managedSession
        scopeLabel="Roadmap Personal workspace"
        captureWorkspaceInvocation={() => ({ workspaceId, revision: 1 })}
        ownsWorkspaceInvocation={() => true}
        operationController={new SessionTenancyOperationController()}
        operationScope={{
          principalId: "33333333-3333-4333-8333-333333333333",
          workspaceId,
          sessionId,
          workspaceTransitionRevision: 1,
        }}
        onRefreshSession={async () => undefined}
        onOpenSession={() => undefined}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SessionTenancyControlFixture />);
