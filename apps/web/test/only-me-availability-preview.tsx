import { createRoot } from "react-dom/client";
import { PrivateChatsRow } from "../src/components/organization/security-page";
import { Section } from "../src/components/ui/section";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import "../src/styles.css";

let enabled = false;
let version = 0;
const organizationId = "00000000-0000-4000-8000-000000000001";
const client = {
  requestJson: async (
    method: string,
    _path: string,
    request?: { enabled: boolean; expectedVersion: number },
  ) => {
    if (method === "PATCH") {
      if (request?.expectedVersion !== version) throw new Error("Preview version conflict");
      enabled = request.enabled;
      version += 1;
    }
    return {
      organizationId,
      enabled,
      available: true,
      version,
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
      <Section title="Chats">
        <PrivateChatsRow
          client={client}
          identity={{
            principalGeneration: 1,
            subjectId: "user:preview",
            organizationId,
            workspaceId: "00000000-0000-4000-8000-000000000002",
          }}
        />
      </Section>
    </div>
  </main>,
);
