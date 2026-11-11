import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

type Module = typeof import("./workspace-reach");
let reach: Module;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  reach = await import("./workspace-reach");
});

afterAll(() => GlobalRegistrator.unregister());

const WORKSPACES = [
  { id: "personal", name: "Personal", personal: true },
  { id: "design", name: "Design preview" },
  { id: "finance", name: "Finance" },
];

type Props = ComponentProps<Module["WorkspaceReachFields"]>;

/** The control with its value kept in state, and every change recorded. */
async function mount(props: Omit<Props, "value" | "onChange"> & { value?: Props["value"] }) {
  const changes: Props["value"][] = [];
  function Harness() {
    const [value, setValue] = useState<Props["value"]>(
      props.value ?? { workspaceIds: null, personalWorkspaces: true },
    );
    return (
      <reach.WorkspaceReachFields
        {...props}
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => root.render(<Harness />));
  return {
    container,
    changes,
    text: () => container.textContent ?? "",
    async choose(title: string) {
      const card = [...container.querySelectorAll<HTMLElement>('[data-slot="choice-card"]')].find(
        (each) => each.textContent?.startsWith(title),
      );
      expect(card).toBeDefined();
      await act(async () => card!.click());
    },
    box(label: string) {
      const element = [...container.querySelectorAll("label")].find(
        (each) => each.textContent === label,
      );
      return element ? (document.getElementById(element.htmlFor) as HTMLInputElement | null) : null;
    },
    async tick(label: string) {
      const box = this.box(label);
      expect(box).not.toBeNull();
      await act(async () => box!.click());
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("who owns a thing and who manages it", () => {
  test("the owner line names the owner and the managers the caller states", () => {
    expect(
      reach.reachOwnerLine(
        { kind: "organization", name: "Acme" },
        "Organization owners manage it.",
      ),
    ).toBe("Belongs to Acme. Organization owners manage it.");
    expect(reach.reachOwnerLine({ kind: "workspace", id: "design", name: "Design preview" })).toBe(
      "Belongs to Design preview.",
    );
    expect(reach.reachOwnerLine({ kind: "person" })).toBe("Belongs to you. Only you manage it.");
  });
});

describe("the short Available in value", () => {
  const organization = { owner: "organization", personalWorkspaces: "choice" } as const;
  test("organization things count workspaces and say Personal", () => {
    const summary = (workspaceIds: string[] | null, personalWorkspaces: boolean) =>
      reach.workspaceReachSummary({ workspaceIds, personalWorkspaces }, organization);
    expect(summary(null, true)).toBe("All workspaces + Personal");
    expect(summary(null, false)).toBe("All workspaces");
    expect(summary(["a"], false)).toBe("1 workspace");
    expect(summary(["a", "b"], true)).toBe("2 workspaces + Personal");
    expect(summary([], true)).toBe("Personal workspaces only");
    expect(summary([], false)).toBe("No workspaces");
  });
  test("workspaces that always have it count once", () => {
    expect(
      reach.workspaceReachSummary(
        { workspaceIds: ["a"], personalWorkspaces: false },
        { owner: "workspace", personalWorkspaces: "none", alwaysIncluded: ["a", "home"] },
      ),
    ).toBe("2 workspaces");
  });
  test("your own things always include your Personal workspace", () => {
    const own = { owner: "person", personalWorkspaces: "always" } as const;
    expect(reach.workspaceReachSummary({ workspaceIds: null, personalWorkspaces: true }, own)).toBe(
      "All my workspaces",
    );
    expect(reach.workspaceReachSummary({ workspaceIds: [], personalWorkspaces: true }, own)).toBe(
      "Only Personal",
    );
    expect(
      reach.workspaceReachSummary({ workspaceIds: ["a", "b"], personalWorkspaces: true }, own),
    ).toBe("Personal + 2 workspaces");
  });
  test("only an organization thing can reach nothing", () => {
    const nothing = { workspaceIds: [], personalWorkspaces: false };
    expect(reach.workspaceReachIsEmpty(nothing, organization)).toBe(true);
    expect(
      reach.workspaceReachIsEmpty(nothing, { ...organization, alwaysIncluded: ["home"] }),
    ).toBe(false);
    expect(
      reach.workspaceReachIsEmpty(
        { workspaceIds: [], personalWorkspaces: true },
        { owner: "organization", personalWorkspaces: "choice" },
      ),
    ).toBe(false);
    expect(
      reach.workspaceReachIsEmpty(nothing, { owner: "person", personalWorkspaces: "always" }),
    ).toBe(false);
  });
});

describe("the Available in control", () => {
  test("an organization thing: owner line, all or selected workspaces, and everyone's Personal workspaces", async () => {
    const view = await mount({
      owner: { kind: "organization", name: "Acme" },
      organizationName: "Acme",
      managedBy: "Organization owners and admins manage it.",
      workspaces: WORKSPACES.filter((workspace) => !workspace.personal),
      hereId: "design",
      seedSelected: () => ["design"],
      personalWorkspaces: "choice",
    });
    try {
      expect(view.text()).toContain("Available in");
      expect(view.text()).toContain("Belongs to Acme. Organization owners and admins manage it.");
      expect(view.text()).toContain("All workspaces in Acme");
      expect(view.text()).not.toContain("Finance");
      await view.choose("Selected workspaces");
      expect(view.changes.at(-1)).toEqual({ workspaceIds: ["design"], personalWorkspaces: true });
      expect(view.text()).toContain("Design preview (this workspace)");
      await view.tick("Finance");
      expect(view.changes.at(-1)).toEqual({
        workspaceIds: ["design", "finance"],
        personalWorkspaces: true,
      });
      await view.tick("Personal workspaces");
      expect(view.changes.at(-1)?.personalWorkspaces).toBe(false);
      await view.choose("All workspaces in Acme");
      expect(view.changes.at(-1)).toEqual({ workspaceIds: null, personalWorkspaces: false });
    } finally {
      await view.unmount();
    }
  });

  test("a workspace's thing always works in its own workspace and never in Personal ones", async () => {
    const view = await mount({
      owner: { kind: "workspace", id: "design", name: "Design preview" },
      organizationName: "Acme",
      managedBy: "Only organization owners can change where it works.",
      value: { workspaceIds: [], personalWorkspaces: false },
      workspaces: WORKSPACES.filter((workspace) => !workspace.personal),
      personalWorkspaces: "none",
    });
    try {
      expect(view.text()).toContain("Belongs to Design preview.");
      expect(view.text()).toContain("Design preview and the workspaces you pick.");
      expect(view.text()).toContain("It belongs to this workspace, so it's always included.");
      const home = view.box("Design preview");
      expect(home?.checked).toBe(true);
      expect(home?.disabled).toBe(true);
      expect(view.text()).not.toContain("Personal workspaces");
    } finally {
      await view.unmount();
    }
  });

  test("your own thing: all your workspaces or a pick, and your Personal workspace is never a row", async () => {
    const view = await mount({
      owner: { kind: "person" },
      organizationName: "Acme",
      value: { workspaceIds: ["design"], personalWorkspaces: true },
      workspaces: WORKSPACES,
      personalWorkspaces: "always",
    });
    try {
      expect(view.text()).toContain("Belongs to you. Only you manage it.");
      expect(view.text()).toContain("All my workspaces");
      expect(view.text()).toContain("Your Personal workspace and the workspaces you pick.");
      expect(view.box("Your Personal workspace")).toBeNull();
      expect(view.box("Design preview")?.checked).toBe(true);
      expect(view.text()).not.toContain("Members can use it");
    } finally {
      await view.unmount();
    }
  });

  test("another way to limit it replaces the workspace list and the Personal choice", async () => {
    let chosen = 0;
    const view = await mount({
      owner: { kind: "organization", name: "Acme" },
      organizationName: "Acme",
      workspaces: WORKSPACES.filter((workspace) => !workspace.personal),
      personalWorkspaces: "choice",
      extraChoice: {
        value: "people",
        title: "Only selected people",
        description: "Only their own chats and automations.",
        chosen: false,
        onChoose: () => chosen++,
      },
    });
    try {
      await view.choose("Only selected people");
      expect(chosen).toBe(1);
      expect(view.changes).toHaveLength(0);
    } finally {
      await view.unmount();
    }
    const chosenView = await mount({
      owner: { kind: "organization", name: "Acme" },
      organizationName: "Acme",
      workspaces: WORKSPACES.filter((workspace) => !workspace.personal),
      personalWorkspaces: "choice",
      extraChoice: {
        value: "people",
        title: "Only selected people",
        description: "Only their own chats and automations.",
        chosen: true,
        onChoose: () => {},
        content: <p>Alex Morgan</p>,
      },
    });
    try {
      expect(chosenView.text()).toContain("Alex Morgan");
      expect(chosenView.text()).not.toContain(
        "Members can use it in their own Personal workspace.",
      );
    } finally {
      await chosenView.unmount();
    }
  });

  test("the workspace list says when it is loading or couldn't load, with a way to try again", async () => {
    let retries = 0;
    const loading = await mount({
      owner: { kind: "organization", name: "Acme" },
      organizationName: "Acme",
      value: { workspaceIds: [], personalWorkspaces: false },
      workspaces: null,
      personalWorkspaces: "choice",
    });
    try {
      expect(loading.container.querySelector('[aria-label="Loading workspaces"]')).not.toBeNull();
    } finally {
      await loading.unmount();
    }
    const failed = await mount({
      owner: { kind: "organization", name: "Acme" },
      organizationName: "Acme",
      value: { workspaceIds: [], personalWorkspaces: false },
      workspaces: null,
      workspacesError: true,
      onRetryWorkspaces: () => retries++,
      personalWorkspaces: "choice",
    });
    try {
      expect(failed.text()).toContain("Couldn't load the organization's workspaces.");
      const retry = [...failed.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Try again",
      );
      await act(async () => retry!.click());
      expect(retries).toBe(1);
    } finally {
      await failed.unmount();
    }
  });

  test("a long workspace list can be searched and says how many are picked", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: `w${index}`,
      name: index === 7 ? "Legal" : `Team ${index}`,
    }));
    const view = await mount({
      owner: { kind: "organization", name: "Acme" },
      organizationName: "Acme",
      value: { workspaceIds: ["w1", "w2"], personalWorkspaces: false },
      workspaces: many,
      personalWorkspaces: "none",
    });
    try {
      expect(view.text()).toContain("2 of 10 selected");
      const search = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Search workspaces"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          "leg",
        );
        const propsKey = Object.keys(search).find((key) => key.startsWith("__reactProps$"))!;
        (search as unknown as Record<string, { onChange: (event: unknown) => void }>)[
          propsKey
        ]!.onChange({ target: search, currentTarget: search });
      });
      expect(view.box("Legal")).not.toBeNull();
      expect(view.box("Team 1")).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
