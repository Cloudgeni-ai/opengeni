import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AccessContext, GitHubAppInfo } from "@/types";
import type { IntegrationChoiceOption, IntegrationViewModel } from "./integration-view-model";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({ useAppContext: () => mutableContext.current }));

const { useGitHubIntegration } = await import("./use-github-integration");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function accessContext(permissions: string[]): AccessContext {
  return {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        subjectId: "subject-a",
        permissions,
      },
    ],
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
  } as unknown as AccessContext;
}

function githubStatus(): GitHubAppInfo {
  const now = new Date().toISOString();
  return {
    configured: true,
    status: "bound",
    setupMode: "platform",
    appId: null,
    clientId: null,
    appSlug: null,
    installUrl: "https://api.example.test/github/connect",
    linkUrl: "https://api.example.test/github/connect",
    installations: [
      {
        installationId: 71,
        githubAccountId: 72,
        accountLogin: "Cloudgeni-ai",
        accountType: "Organization",
        lifecycle: "active",
        repositoryScope: "selected",
        repositoryCount: 1,
        configureUrl: "https://api.example.test/github/configure",
        createdAt: now,
        updatedAt: now,
      },
    ],
    missing: [],
  };
}

async function renderAdapter(context: Record<string, unknown>) {
  mutableContext.current = context;
  let captured: IntegrationViewModel | null = null;
  function Probe() {
    captured = useGitHubIntegration({ workspaceId: WORKSPACE_ID }).model;
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    model: () => {
      if (!captured) throw new Error("GitHub adapter model was not captured");
      return captured;
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function appContext(permissions: string[], update: ReturnType<typeof mock>) {
  return {
    accessContext: accessContext(permissions),
    githubStatus: githubStatus(),
    githubRepos: [],
    githubStatusFailed: false,
    githubCatalogReady: true,
    repoBusy: false,
    githubAppBusy: false,
    personalGitHubStatus: { enabled: false, connection: null, reviewUrl: null },
    personalGitHubSelection: null,
    personalGitHubBusy: false,
    client: {
      getGitHubActionPolicies: mock(async () => ({
        enabled: true,
        actors: [
          {
            kind: "workspace_app" as const,
            installationId: 71,
            label: "OpenGeni bot on Cloudgeni-ai",
            groups: { routine: "ask" as const, review: "ask" as const, merge: "ask" as const },
          },
        ],
      })),
      updateGitHubActionPolicy: update,
    },
    disconnectGitHubInstallation: async () => true,
    startGitHubAppManifestFlow: async () => {},
    refreshGitHub: async () => {},
  };
}

function choice(model: IntegrationViewModel, suffix: string): IntegrationChoiceOption {
  const option = model.options.find(
    (candidate) => candidate.kind === "choice" && candidate.id.endsWith(suffix),
  );
  if (!option || option.kind !== "choice") throw new Error(`Missing policy option ${suffix}`);
  return option;
}

describe("GitHub action approval controls", () => {
  test("allows routine PR work without changing review or merge", async () => {
    const update = mock(async () => ({
      kind: "workspace_app" as const,
      installationId: 71,
      label: "OpenGeni bot on Cloudgeni-ai",
      groups: { routine: "allow" as const, review: "ask" as const, merge: "ask" as const },
    }));
    const rendered = await renderAdapter(appContext(["github:manage"], update));
    try {
      expect(choice(rendered.model(), "-routine").value).toBe("ask");
      expect(choice(rendered.model(), "-merge").value).toBe("ask");
      await act(async () => {
        choice(rendered.model(), "-routine").onChange("allow");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(update).toHaveBeenCalledWith(WORKSPACE_ID, {
        actor: { kind: "workspace_app", installationId: 71 },
        group: "routine",
        decision: "allow",
      });
      expect(choice(rendered.model(), "-routine").value).toBe("allow");
      expect(choice(rendered.model(), "-review").value).toBe("ask");
      expect(choice(rendered.model(), "-merge").value).toBe("ask");
    } finally {
      await rendered.unmount();
    }
  });

  test("shows the policy read-only without GitHub management authority", async () => {
    const rendered = await renderAdapter(
      appContext(
        ["github:use"],
        mock(async () => ({})),
      ),
    );
    try {
      expect(choice(rendered.model(), "-routine").disabled).toBe(true);
      expect(choice(rendered.model(), "-review").disabled).toBe(true);
      expect(choice(rendered.model(), "-merge").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });
});
