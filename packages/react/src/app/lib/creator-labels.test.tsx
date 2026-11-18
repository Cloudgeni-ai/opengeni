import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppContext } = await import("../app-context");
const { creatorInitials } = await import("./creator-initials");
const { forgetCreatorLabels, resolveCreatorLabel, useResolvedCreator } =
  await import("./creator-labels");

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const me = { subjectId: "user:3BvWq9xYz", subjectLabel: "bendik@cloudgeni.ai" };

afterEach(() => forgetCreatorLabels());

function Provide(props: { value: never; children: React.ReactNode }) {
  return <AppContext.Provider value={props.value}>{props.children}</AppContext.Provider>;
}

describe("resolveCreatorLabel", () => {
  test("names the signed-in person from their own label, the label the app freezes", () => {
    const resolved = resolveCreatorLabel({ kind: "subject", subjectId: me.subjectId }, me, null);
    expect(resolved?.label).toBe("bendik@cloudgeni.ai");
    expect(creatorInitials(resolved!)).toBe("BE");
  });

  test("names anyone else from the workspace's members", () => {
    const members = new Map([["user:kari", "Kari Nordmann"]]);
    const resolved = resolveCreatorLabel({ kind: "subject", subjectId: "user:kari" }, me, members);
    expect(creatorInitials(resolved!)).toBe("KN");
  });

  test("keeps a frozen label, machinery and unknown people as they are", () => {
    const labeled = { kind: "subject", subjectId: me.subjectId, label: "Frozen Name" } as const;
    expect(resolveCreatorLabel(labeled, me, null)).toBe(labeled);
    const key = { kind: "subject", subjectId: "api_key:k1" } as const;
    expect(resolveCreatorLabel(key, { subjectId: "api_key:k1", subjectLabel: "x" }, null)).toBe(
      key,
    );
    const service = { kind: "service", subjectId: "scheduler" } as const;
    expect(resolveCreatorLabel(service, me, new Map())).toBe(service);
    const stranger = { kind: "subject", subjectId: "user:gone" } as const;
    const unresolved = resolveCreatorLabel(stranger, me, new Map());
    expect(unresolved).toBe(stranger);
    // Still no id fragment.
    expect(creatorInitials(unresolved!)).toBeNull();
  });
});

describe("useResolvedCreator", () => {
  test("reads members once per workspace for every unlabeled row, and never for your own", async () => {
    let reads = 0;
    const client = {
      listWorkspaceMembers: async () => {
        reads += 1;
        return [{ subjectId: "user:kari", subjectLabel: "Kari Nordmann" }];
      },
    };
    const seen: Array<string | null> = [];
    function Row({ subjectId }: { subjectId: string }) {
      const creator = useResolvedCreator(WORKSPACE, { kind: "subject", subjectId });
      seen.push(creator ? creatorInitials(creator) : null);
      return <span data-row={subjectId}>{creator ? creatorInitials(creator) : ""}</span>;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const context = { client, accessContext: me } as never;
    await act(async () =>
      root.render(
        <Provide value={context}>
          <Row subjectId={me.subjectId} />
        </Provide>,
      ),
    );
    expect(container.textContent).toBe("BE");
    expect(reads).toBe(0);
    await act(async () =>
      root.render(
        <Provide value={context}>
          <Row subjectId={me.subjectId} />
          <Row subjectId="user:kari" />
          <Row subjectId="user:kari" />
        </Provide>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toBe("BEKNKN");
    expect(reads).toBe(1);
    // Never the id's first letters while members load.
    expect(seen).not.toContain("3B");
    await act(async () => root.unmount());
    container.remove();
  });
});
