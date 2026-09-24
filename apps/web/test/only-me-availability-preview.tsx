import { createRoot } from "react-dom/client";
import { OrganizationPrivateSessionsSection } from "../src/components/organization-admin";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import "../src/styles.css";

let enabled = false;
const organizationId = "00000000-0000-4000-8000-000000000001";
const client = {
  requestJson: async (method: string) => {
    if (method === "PATCH") enabled = !enabled;
    return {
      organizationId,
      enabled,
      available: true,
      version: enabled ? 1 : 0,
      updatedAt: "2026-09-24T00:00:00.000Z",
    };
  },
} as unknown as OpenGeniBrowserClient;

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg p-10 text-fg">
    <div className="mx-auto max-w-5xl">
      <p className="mb-6 text-sm text-fg-muted">
        Organization settings · sample activation preview
      </p>
      <OrganizationPrivateSessionsSection
        client={client}
        identity={{
          principalGeneration: 1,
          subjectId: "user:preview",
          organizationId,
          workspaceId: "00000000-0000-4000-8000-000000000002",
        }}
        actorRole="owner"
        managedSession
      />
    </div>
  </main>,
);
