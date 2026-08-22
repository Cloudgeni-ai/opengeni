import { createRoot } from "react-dom/client";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";

import { SessionTenancyControl } from "../src/components/session/session-tenancy-control";
import { SessionTenancyOperationController } from "../src/lib/session-tenancy-operation-controller";
import type { Session } from "../src/types";
import "../src/styles.css";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";

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
          } as Session
        }
        client={{} as OpenGeniCoreClient}
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
