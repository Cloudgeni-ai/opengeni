import { createRoot } from "react-dom/client";
import { OrganizationApiKeysSection } from "../src/components/organization-api-keys-section";
import type { OrganizationApiKeysSectionProps } from "../src/components/organization-api-keys-section";
import "../src/styles.css";

const organizationId = "22222222-2222-4222-8222-222222222222";
const submittedRequests: unknown[] = [];
Object.assign(window, { submittedRequests });

const createApiKey: OrganizationApiKeysSectionProps["createApiKey"] = async (request) => {
  submittedRequests.push(request);
  throw new Error("Preview only: no real key was created.");
};

createRoot(document.getElementById("root")!).render(
  <main className="min-h-dvh bg-bg px-6 py-6 text-fg">
    <div className="mx-auto max-w-[960px]">
      <p className="mb-6 text-xs text-fg-muted">Preview · Sample organization · No real keys</p>
      <OrganizationApiKeysSection
        organizationId={organizationId}
        canManage
        view="new-key"
        onViewChange={() => undefined}
        listApiKeys={async () => []}
        createApiKey={createApiKey}
        deleteApiKey={async () => {
          throw new Error("Preview only");
        }}
      />
    </div>
  </main>,
);
