import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SkillRecord } from "@opengeni/sdk";
import { act, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppContextValue } from "@/context";
import type { AnyRouter } from "@tanstack/react-router";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} = await import("@tanstack/react-router");
const { CapabilityPageSlotContext } =
  await import("@/components/capabilities/capability-page-slot");
const { SkillsPanelContent } = await import("./skills-panel");

const record: SkillRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  stableKey: "example",
  title: "Example skill",
  description: "Use for examples",
  scope: "workspace",
  scopeVersion: 1,
  activationMode: "workspace_managed",
  status: "active",
  activeRevisionId: "revision",
  revisionId: "revision",
  pendingRevisionIds: [],
  contentHash: null,
  source: null,
  files: [
    {
      path: "SKILL.md",
      content: "---\nname: example\ndescription: Use for examples\n---\nInstructions",
    },
  ],
};
const context = {
  authSession: null,
  accessContext: {
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "one",
        accountId: "account",
        principalKind: "human_session",
        permissions: ["workspace:admin"],
      },
    ],
  },
  client: {
    listWorkspaceSkills: async () => ({ skills: [record], nextCursor: null }),
    readWorkspaceSkill: async () => record,
    getPreferenceRegistry: async () => ({ revisions: [] }),
  },
} as unknown as AppContextValue;
const catalogUrl = "/workspaces/one/plugins";
const skillUrl = `${catalogUrl}?open=skill%3A${record.id}`;

function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  const openKey = new URLSearchParams(location.searchStr).get("open");
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const slot = useMemo(
    () => ({
      target,
      openKey,
      open: (key: string, options?: { replace?: boolean }) => {
        void navigate({
          href: `${catalogUrl}?open=${encodeURIComponent(key)}`,
          replace: options?.replace,
        });
      },
      close: (options?: { replace?: boolean }) => {
        void navigate({ href: catalogUrl, replace: options?.replace });
      },
    }),
    [target, openKey, navigate],
  );
  return (
    <CapabilityPageSlotContext.Provider value={slot}>
      <output data-current-url>{location.href}</output>
      <div hidden={Boolean(openKey)}>
        <SkillsPanelContent context={context} workspaceId="one" />
      </div>
      <div ref={setTarget} />
    </CapabilityPageSlotContext.Provider>
  );
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
  }
}
async function mounted(run: (container: HTMLDivElement, router: AnyRouter) => Promise<void>) {
  const history = createMemoryHistory({ initialEntries: [catalogUrl, skillUrl] });
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$workspaceId/plugins",
    component: Harness,
  });
  const other = createRoute({
    getParentRoute: () => rootRoute,
    path: "/other",
    component: () => <p>Other route</p>,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([route, other]), history });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();
    expect(container.querySelector("textarea")?.value).toBe(record.files[0]!.content);
    await run(container, router);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
async function edit(container: HTMLElement, text = "Unsaved Skill draft") {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    const key = Object.keys(textarea).find((name) => name.startsWith("__reactProps$"));
    const props = key
      ? (textarea as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key]
      : undefined;
    props?.onChange?.({ target: { value: text } });
  });
}
async function click(label: string) {
  const region = document.querySelector('[role="dialog"]') ?? document.body;
  const button = [...region.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await settle();
}

test("dirty SPA navigation cancel keeps the editor, draft and URL; confirm leaves", async () => {
  await mounted(async (container, router) => {
    await edit(container);
    // Memory history does not block POP actions. Exercise the same real-router
    // slot navigation here; native browser Back is checked in the browser preview.
    await act(async () => {
      void router.navigate({ href: catalogUrl });
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Discard unsaved Skill changes?",
    );
    expect(router.state.location.href).toBe(skillUrl);
    await click("Cancel");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe("Unsaved Skill draft");
    expect(router.state.location.href).toBe(skillUrl);
    await act(async () => {
      void router.navigate({ href: catalogUrl });
    });
    await settle();
    await click("Discard changes");
    expect(router.state.location.href).toBe(catalogUrl);
    expect(container.querySelector("textarea")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

test("clean SPA Back does not require confirmation", async () => {
  await mounted(async (container, router) => {
    await act(async () => router.history.back());
    await settle();
    expect(router.state.location.href).toBe(catalogUrl);
    expect(container.querySelector("textarea")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

test("dirty navigation to another route is cancelable before the editor unmounts", async () => {
  await mounted(async (container, router) => {
    await edit(container);
    await act(async () => {
      void router.navigate({ href: "/other" });
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Discard unsaved Skill changes?",
    );
    await click("Cancel");
    expect(container.querySelector("textarea")?.value).toBe("Unsaved Skill draft");
    expect(router.state.location.href).toBe(skillUrl);
    await act(async () => {
      void router.navigate({ href: "/other" });
    });
    await settle();
    await click("Discard changes");
    expect(container.textContent).toContain("Other route");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

test("the existing explicit Back confirmation discards once without a second router prompt", async () => {
  await mounted(async (container, router) => {
    await edit(container);
    await click("Capabilities");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Discard unsaved Skill changes?",
    );
    await click("Discard changes");
    expect(router.state.location.href).toBe(catalogUrl);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
