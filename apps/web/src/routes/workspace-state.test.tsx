import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceStateResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { useWorkspaceStateInventory } from "./workspace-state-loader";
import { AttemptGovernanceInventory } from "./workspace-state";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  GlobalRegistrator.unregister();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(workspaceId: string): WorkspaceStateResponse {
  return { workspaceId, generatedAt: "2026-07-30T12:00:00.000Z" } as WorkspaceStateResponse;
}

describe("Workspace State loader", () => {
  test("fences a late response after switching workspaces", async () => {
    const workspaceA = "00000000-0000-4000-8000-000000000001";
    const workspaceB = "00000000-0000-4000-8000-000000000002";
    const pendingA = deferred<WorkspaceStateResponse>();
    const pendingB = deferred<WorkspaceStateResponse>();
    const client: Parameters<typeof useWorkspaceStateInventory>[0] = {
      getWorkspaceState: async (workspaceId) =>
        await (workspaceId === workspaceA ? pendingA.promise : pendingB.promise),
    };
    let observed: ReturnType<typeof useWorkspaceStateInventory> | null = null;
    const current = () => observed as unknown as ReturnType<typeof useWorkspaceStateInventory>;

    function Harness({ workspaceId }: { workspaceId: string }) {
      observed = useWorkspaceStateInventory(client, workspaceId);
      return (
        <output>{observed.state?.workspaceId ?? (observed.loading ? "loading" : "empty")}</output>
      );
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness workspaceId={workspaceA} />));
    expect(container.textContent).toBe("loading");

    await act(async () => root.render(<Harness workspaceId={workspaceB} />));
    expect(container.textContent).toBe("loading");
    expect(current().state).toBeNull();

    await act(async () => pendingB.resolve(response(workspaceB)));
    expect(container.textContent).toBe(workspaceB);
    expect(current().loading).toBe(false);
    expect(current().error).toBeNull();

    await act(async () => pendingA.resolve(response(workspaceA)));
    expect(container.textContent).toBe(workspaceB);
    expect(current().state?.workspaceId).toBe(workspaceB);
    expect(current().loading).toBe(false);
    expect(current().error).toBeNull();
    await act(async () => root.unmount());
  });

  test("fences a late response after switching inspected attempts", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000003";
    const attemptA = "00000000-0000-4000-8000-000000000011";
    const attemptB = "00000000-0000-4000-8000-000000000012";
    const pendingA = deferred<WorkspaceStateResponse>();
    const pendingB = deferred<WorkspaceStateResponse>();
    const client: Parameters<typeof useWorkspaceStateInventory>[0] = {
      getWorkspaceState: async (_workspaceId, options) =>
        await (options?.attemptId === attemptA ? pendingA.promise : pendingB.promise),
    };
    let observed: ReturnType<typeof useWorkspaceStateInventory> | null = null;
    const current = () => observed as unknown as ReturnType<typeof useWorkspaceStateInventory>;

    function Harness({ attemptId }: { attemptId: string }) {
      observed = useWorkspaceStateInventory(client, workspaceId, attemptId);
      return <output>{observed.state?.generatedAt ?? "loading"}</output>;
    }

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness attemptId={attemptA} />));
    await act(async () => root.render(<Harness attemptId={attemptB} />));

    await act(async () =>
      pendingB.resolve({
        ...response(workspaceId),
        generatedAt: "2026-08-03T11:00:02.000Z",
      }),
    );
    expect(container.textContent).toBe("2026-08-03T11:00:02.000Z");

    await act(async () =>
      pendingA.resolve({
        ...response(workspaceId),
        generatedAt: "2026-08-03T11:00:01.000Z",
      }),
    );
    expect(container.textContent).toBe("2026-08-03T11:00:02.000Z");
    expect(current().state?.generatedAt).toBe("2026-08-03T11:00:02.000Z");
    await act(async () => root.unmount());
  });
});

describe("accepted-attempt governance comparison", () => {
  test("renders the bounded current authority beside the accepted snapshot", async () => {
    const state = {
      workspaceId: "00000000-0000-4000-8000-000000000021",
      generatedAt: "2026-08-03T12:00:00.000Z",
      truth: {
        current: {
          source: "read_time_projection",
          capturedAt: "2026-08-03T12:00:00.000Z",
        },
        attemptGovernance: {
          status: "available",
          attemptId: "00000000-0000-4000-8000-000000000022",
          executionGeneration: 1,
          acceptedAt: "2026-08-03T11:00:00.000Z",
          policySnapshot: {
            status: "available",
            id: "00000000-0000-4000-8000-000000000023",
            createdAt: "2026-08-03T11:00:01.000Z",
            entryHash: "a".repeat(64),
            policyRole: null,
            roleSource: "none",
            entries: [],
          },
          preferenceSnapshot: {
            status: "available",
            id: "00000000-0000-4000-8000-000000000024",
            createdAt: "2026-08-03T11:00:01.000Z",
            descriptorHash: "b".repeat(64),
            descriptorCount: 1,
            truncated: false,
          },
          drift: {
            overall: "superseded",
            policy: {
              status: "superseded",
              snapshotHash: "c".repeat(64),
              currentHash: "d".repeat(64),
              snapshotTargetCount: 1,
              currentTargetCount: 1,
            },
            preferences: {
              status: "changed",
              snapshotHash: "e".repeat(64),
              currentHash: "f".repeat(64),
              snapshotDescriptorCount: 1,
              currentDescriptorCount: 2,
              snapshotTruncated: false,
              currentTruncated: false,
            },
          },
        },
      },
      policy: {
        authority: "workspace_instruction_policy_heads",
        activeHeads: [],
        activeHeadsTruncated: false,
        latestRevision: null,
        legacyRuntime: {
          source: "deployment_default",
          workspaceOverrideConfigured: false,
        },
        runtimeComposition: { status: "not_implemented" },
      },
      knowledge: {
        availability: "unavailable",
        reason: "missing_permission",
        requiredPermission: "documents:search",
      },
    } satisfies WorkspaceStateResponse;
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <AttemptGovernanceInventory
          state={state}
          attemptInput={state.truth.attemptGovernance.attemptId}
          onAttemptInput={() => undefined}
          onInspect={(event) => event.preventDefault()}
          onClear={() => undefined}
        />,
      ),
    );

    expect(container.textContent).toContain("Current versus snapshot");
    const policy = container.querySelector(
      '[aria-label="Instruction policy governance comparison"]',
    );
    const preferences = container.querySelector(
      '[aria-label="Structured preferences governance comparison"]',
    );
    expect(policy?.textContent).toContain("Accepted snapshot");
    expect(policy?.textContent).toContain("1 frozen target");
    expect(policy?.textContent).toContain("Current authority");
    expect(policy?.textContent).toContain("1 current target");
    expect(policy?.textContent).toContain(`sha256:${"c".repeat(64)}`);
    expect(policy?.textContent).toContain(`sha256:${"d".repeat(64)}`);
    expect(preferences?.textContent).toContain("1 frozen descriptor");
    expect(preferences?.textContent).toContain("2 current descriptors");
    expect(preferences?.textContent).toContain("Coverage: complete");
    expect(preferences?.textContent).toContain(
      "The current target or descriptor set added or removed an entry.",
    );

    await act(async () => root.unmount());
  });
});
