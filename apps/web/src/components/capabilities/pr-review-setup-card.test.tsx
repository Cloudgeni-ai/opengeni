import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  PrReviewAppRegistration,
  PrReviewManagedGitHubSetup,
  PrReviewRepositoryBinding,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const registrationId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";

const context = {
  clientConfig: { defaultModel: "gpt-5.6-sol" },
};

const modelCatalog = {
  models: [],
  rows: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      billingClass: "opengeni_credits" as const,
      billingClassLabel: "OpenGeni",
      selectable: true,
      unavailableReason: null,
      provider: "opengeni",
      providerLabel: "OpenGeni",
      catalog: { id: "gpt-5.6-sol", source: "opengeni" },
    },
    {
      id: "codex/gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      billingClass: "codex_subscription" as const,
      billingClassLabel: "Codex",
      selectable: true,
      unavailableReason: null,
      provider: "codex",
      providerLabel: "Codex",
      catalog: { id: "codex/gpt-5.6-sol", source: "codex" },
    },
  ],
  loading: false,
  error: null,
  refresh: async () => undefined,
};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@/lib/use-workspace-model-catalog", () => ({
  useWorkspaceModelCatalog: () => modelCatalog,
}));

const { PrReviewSetupCard } = await import("./pr-review-setup-card");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const registration: PrReviewAppRegistration = {
  id: registrationId,
  sourceId: "44444444-4444-4444-8444-444444444444",
  accountId: "55555555-5555-4555-8555-555555555555",
  workspaceId,
  name: "OpenGeni Lens · Cloudgeni-ai",
  provider: "github",
  providerBaseUrl: "https://github.com",
  appId: "4749390",
  installationId: "157233235",
  providerAccountLogin: "Cloudgeni-ai",
  providerAccountType: "Organization",
  credentialKind: "managed_github_app",
  hasCredential: true,
  accessTokenExpiresAt: null,
  webhookAuthKind: "hmac_sha256",
  hasWebhookSecret: true,
  webhookUsername: null,
  webhookPath: "/v1/webhooks/pr-review/github",
  status: "active",
  createdBySubjectId: "user:owner",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const repository: PrReviewRepositoryBinding = {
  id: bindingId,
  triggerId: "66666666-6666-4666-8666-666666666666",
  accountId: registration.accountId,
  workspaceId,
  registrationId,
  provider: "github",
  repositoryUri: "https://github.com/Cloudgeni-ai/opengeni.git",
  repositoryFullName: "Cloudgeni-ai/opengeni",
  providerRepositoryId: "1212552738",
  installationId: registration.installationId,
  projectId: null,
  model: null,
  additionalInstructions: null,
  status: "active",
  createdBySubjectId: "user:owner",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const managedSetup: PrReviewManagedGitHubSetup = {
  configured: true,
  status: "connected",
  appName: "OpenGeni Lens",
  connectUrl: "https://github.com/apps/opengeni-lens/installations/new",
  installations: [
    {
      registrationId,
      installationId: registration.installationId!,
      accountLogin: "Cloudgeni-ai",
      configureUrl: "https://github.com/organizations/Cloudgeni-ai/settings/installations/1",
      repositoryCount: 1,
    },
  ],
  missing: [],
};

async function render(client: OpenGeniBrowserClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PrReviewSetupCard client={client} workspaceId={workspaceId} canManage={true} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("OpenGeni Review Bot execution model", () => {
  test("managed GitHub repositories can select the connected Codex billing rail", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      requestJson: mock(async (method: string, path: string, body?: unknown) => {
        requests.push({ method, path, body });
        if (method === "GET" && path.endsWith("/pr-review/registrations")) {
          return { registrations: [registration], repositories: [repository] };
        }
        if (method === "GET" && path.endsWith("/pr-review/github")) {
          return managedSetup;
        }
        if (method === "PATCH" && path.endsWith(`/pr-review/repositories/${bindingId}`)) {
          return { ...repository, model: (body as { model: string | null }).model };
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
      requestVoid: mock(async () => undefined),
    } as unknown as OpenGeniBrowserClient;

    const rendered = await render(client);
    try {
      expect(rendered.container.textContent).toContain("Review execution");
      expect(rendered.container.textContent).toContain("Cloudgeni-ai/opengeni");
      expect(rendered.container.textContent).toContain("do not consume OpenGeni credits");

      const select = rendered.container.querySelector<HTMLSelectElement>(
        'select[aria-label="Review model for Cloudgeni-ai/opengeni"]',
      );
      expect(select).not.toBeNull();
      expect([...select!.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
        "OpenGeni",
        "Codex",
      ]);
      expect(select!.value).toBe("");

      await act(async () => {
        select!.value = "codex/gpt-5.6-sol";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(requests).toContainEqual({
        method: "PATCH",
        path: `/v1/workspaces/${workspaceId}/pr-review/repositories/${bindingId}`,
        body: { model: "codex/gpt-5.6-sol" },
      });
      expect(select!.value).toBe("codex/gpt-5.6-sol");
      expect(rendered.container.textContent).toContain("Codex");

      await act(async () => {
        select!.value = "";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(requests).toContainEqual({
        method: "PATCH",
        path: `/v1/workspaces/${workspaceId}/pr-review/repositories/${bindingId}`,
        body: { model: null },
      });
      expect(select!.value).toBe("");
    } finally {
      await rendered.unmount();
    }
  });
});
