import "@/app-host";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/* ----------------------------------------------------------------------------
   Get started: the showcase (example, setups, one button) and a setup opening
   on the Enable page, against a mocked client.
   -------------------------------------------------------------------------- */

const templates = [
  {
    key: "pr-reviewer",
    name: "PR reviewer",
    description: "Reviews pull requests.",
    suggestedTriggers: [{ name: "When a pull request opens", oneClick: true }],
    setup: {
      connections: [{ provider: "github.com", name: "GitHub", required: true, why: "x" }],
      repository: "optional",
      worksWellWith: null,
      wontDoWithoutAsking: [],
      firstMessage: null,
      firstJob: null,
    },
  },
  {
    key: "triage",
    name: "Triage",
    description: "Sorts issues.",
    suggestedTriggers: [{ name: "When a Linear issue is created" }],
    setup: {
      connections: [
        { provider: "github.com", name: "GitHub", required: false, why: "x" },
        { provider: "linear.app", name: "Linear", required: false, why: "x" },
      ],
      repository: null,
      worksWellWith: null,
      wontDoWithoutAsking: [],
      firstMessage: null,
      firstJob: null,
    },
  },
];
const client = {
  listAgentTemplates: mock(async () => templates),
  getAgentTemplateReadiness: mock(async () => ({
    ready: true,
    reason: null,
    connections: [],
    missing: [],
    requiredConnected: 0,
    requiredTotal: 0,
  })),
  listAgents: mock(async () => []),
  listScheduledTasks: mock(async () => []),
};
const context: Record<string, unknown> = {
  client,
  githubStatus: { status: "bound" },
  accessContext: {
    workspaceGrants: [{ workspaceId: "workspace-a", permissions: ["sessions:create"] }],
  },
};
const navigations: unknown[] = [];

mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("@opengeni/react/app/lib/navigation", () => ({
  useNavigate: () => (options: unknown) => navigations.push(options),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("@opengeni/react/app/components/agents/agent-trigger-dialog", () => ({
  addAgentSuggestedTrigger: mock(async () => ({ kind: "needs_setup" })),
  agentTriggerSaveError: () => "error",
  AgentTriggerDialog: () => null,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { GetStartedPage } = await import("./get-started-page");

afterAll(() => {
  mock.restore();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      GlobalRegistrator.unregister();
      resolve();
    }, 50),
  );
});

beforeEach(() => {
  navigations.length = 0;
  document.body.innerHTML = "";
});

async function render(setupKey?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<GetStartedPage workspaceId="workspace-a" setupKey={setupKey} />);
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { container, root };
}

function example(container: HTMLElement): string | null {
  return (
    container.querySelector("[data-setup-example]")?.getAttribute("data-setup-example") ?? null
  );
}

test("the showcase: an example, three setups and one button with what it needs", async () => {
  const { container, root } = await render();
  expect(container.querySelector("[data-setup-example]")?.textContent).toContain("Example");
  expect(example(container)).toBe("pr-reviews");
  expect(container.textContent).toContain("Retries never stop when the endpoint returns 410.");
  const setups = container.querySelectorAll("[data-setup]");
  expect(setups).toHaveLength(3);
  const open = container.querySelector<HTMLButtonElement>("[data-get-started-open]");
  expect(open?.textContent).toBe("Set up PR reviews");
  expect(container.querySelector("[data-get-started-needs]")?.textContent).toBe("Needs GitHub");
  expect(
    container.querySelectorAll("button[data-variant=default], [data-get-started-open]"),
  ).toHaveLength(1);
  root.unmount();
});

test("hovering or selecting a setup swaps the example, and the button opens Enable for it", async () => {
  const { container, root } = await render();
  const triage = container.querySelector<HTMLElement>('[data-setup="issue-triage"]');
  await act(async () => {
    triage?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(example(container)).toBe("issue-triage");
  expect(triage?.getAttribute("aria-checked")).toBe("true");
  // The setup requires Linear although the agent alone doesn't.
  expect(container.querySelector("[data-get-started-needs]")?.textContent).toBe("Needs Linear");
  await act(async () => {
    container.querySelector<HTMLElement>('[data-setup="product-analytics"]')?.click();
  });
  expect(example(container)).toBe("product-analytics");
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-get-started-open]")?.click();
  });
  expect(navigations.at(-1)).toEqual({
    href: "/workspaces/workspace-a/get-started?setup=product-analytics",
  });
  root.unmount();
});

test("a setup opens on the Enable page, with the way back to Get started", async () => {
  const { container, root } = await render("pr-reviews");
  expect(container.textContent).toContain("Set up Review pull requests");
  expect(container.querySelector("[data-enable-turn-on]")).not.toBeNull();
  expect(container.textContent).toContain("Get started");
  root.unmount();
});
