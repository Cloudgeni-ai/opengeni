import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CompanyProfileListResponse, CompanyProfileRevision } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const activeRevisionId = "00000000-0000-4000-8000-000000000003";
const proposalRevisionId = "00000000-0000-4000-8000-000000000004";
const activatedProposalId = "00000000-0000-4000-8000-000000000005";

const activateCompanyProfileRevision = mock(
  async (_workspaceId: string, _revisionId: string, _request: Record<string, unknown>) => ({
    revision: null,
    head: null,
    event: null,
  }),
);

const context = {
  client: { activateCompanyProfileRevision },
  accessContext: {
    accountGrants: [] as { accountId: string; permissions: string[] }[],
    workspaceGrants: [{ workspaceId, accountId, permissions: ["workspace:read"] }],
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

const { CompanyProfileInventory, CompanyProfilePendingProposals, pendingCompanyProfileProposals } =
  await import("./workspace-state");

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

function revision(input: {
  id: string;
  revision: number;
  intent: "active" | "proposal";
  source: "human" | "durable_learning";
  mission: string;
}): CompanyProfileRevision {
  return {
    id: input.id,
    revision: input.revision,
    contentHash: "a".repeat(64),
    operationId: `00000000-0000-4000-8000-0000000001${String(input.revision).padStart(2, "0")}`,
    accountId,
    intent: input.intent,
    profile: {
      identity: "CloudGeni builds OpenGeni.",
      mission: input.mission,
      products: [{ key: "opengeni", content: "Autonomous work platform." }],
      customers: [],
      goals: [{ key: "simple-brain", content: "Make the agent brain simple and useful." }],
      constraints: [],
    },
    provenance: {
      source: input.source,
      sourceId: input.source === "durable_learning" ? "agent-attempt:attempt-1" : null,
    },
    supersedesRevisionId: null,
    createdBySubjectId: input.source === "human" ? "user:admin" : "worker:attempt",
    createdAt: `2026-08-0${input.revision}T10:00:00.000Z`,
  };
}

const response: CompanyProfileListResponse = {
  current: {
    accountId,
    revisionId: activeRevisionId,
    revision: 1,
    contentHash: "a".repeat(64),
    activationVersion: 2,
    activatedAt: "2026-08-02T10:00:00.000Z",
  },
  activeRevision: revision({
    id: activeRevisionId,
    revision: 1,
    intent: "active",
    source: "human",
    mission: "Current mission.",
  }),
  revisions: [
    revision({
      id: proposalRevisionId,
      revision: 3,
      intent: "proposal",
      source: "durable_learning",
      mission: "Proposed mission from the agent.",
    }),
    revision({
      id: activatedProposalId,
      revision: 2,
      intent: "proposal",
      source: "durable_learning",
      mission: "Already activated proposal.",
    }),
    revision({
      id: activeRevisionId,
      revision: 1,
      intent: "active",
      source: "human",
      mission: "Current mission.",
    }),
  ],
  activationEvents: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      operationId: "00000000-0000-4000-8000-000000000022",
      accountId,
      type: "activate",
      activationVersion: 2,
      oldRevision: { id: activatedProposalId, revision: 2, contentHash: "a".repeat(64) },
      newRevision: { id: activeRevisionId, revision: 1, contentHash: "a".repeat(64) },
      actorSubjectId: "user:admin",
      reason: "Rollback",
      createdAt: "2026-08-02T10:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000023",
      operationId: "00000000-0000-4000-8000-000000000024",
      accountId,
      type: "activate",
      activationVersion: 1,
      oldRevision: null,
      newRevision: { id: activatedProposalId, revision: 2, contentHash: "a".repeat(64) },
      actorSubjectId: "user:admin",
      reason: "Activate",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  nextAfterRevision: null,
};

describe("Company profile pending proposals", () => {
  test("lists only proposals that were never activated, newest first", () => {
    expect(pendingCompanyProfileProposals(response).map((item) => item.id)).toEqual([
      proposalRevisionId,
    ]);
    expect(pendingCompanyProfileProposals(null)).toEqual([]);
  });

  test("renders nothing without pending proposals", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CompanyProfilePendingProposals
          workspaceId={workspaceId}
          canManage
          inventory={{ response: { ...response, revisions: [] }, reload: async () => undefined }}
        />,
      ),
    );
    expect(container.textContent).toBe("");
    await act(async () => root.unmount());
  });

  test("shows proposal content with an Activate action for admins and reloads after activation", async () => {
    activateCompanyProfileRevision.mockClear();
    const reload = mock(async () => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CompanyProfilePendingProposals
          workspaceId={workspaceId}
          canManage
          inventory={{ response, reload }}
        />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Pending proposals");
    expect(text).toContain("r3");
    expect(text).toContain("Durable learning");
    expect(text).toContain("Mission: Proposed mission from the agent.");
    expect(text).toContain("opengeni: Autonomous work platform.");
    expect(text).toContain("simple-brain: Make the agent brain simple and useful.");
    expect(text).not.toContain("Already activated proposal.");
    expect(text).not.toContain("Only an organization owner or admin can activate this proposal.");

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Activate");
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(activateCompanyProfileRevision).toHaveBeenCalledTimes(1);
    const [calledWorkspaceId, calledRevisionId, request] =
      activateCompanyProfileRevision.mock.calls[0]!;
    expect(calledWorkspaceId).toBe(workspaceId);
    expect(calledRevisionId).toBe(proposalRevisionId);
    expect(request).toMatchObject({
      expectedCurrentRevisionId: activeRevisionId,
      expectedActivationVersion: 2,
      reason: "Activate reviewed company-profile proposal",
    });
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  test("shares one inventory between the pending card and the manual editor and re-syncs after a conflict", async () => {
    activateCompanyProfileRevision.mockClear();
    activateCompanyProfileRevision.mockImplementationOnce(async () => {
      throw new Error("The active company profile changed in another request");
    });
    const reload = mock(async () => undefined);
    const inventory = { response, reload, loading: false, error: null };
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <>
          <CompanyProfilePendingProposals
            workspaceId={workspaceId}
            canManage
            inventory={inventory}
          />
          <CompanyProfileInventory workspaceId={workspaceId} inventory={inventory} />
        </>,
      ),
    );
    const text = container.textContent ?? "";
    // Both surfaces render from the same response: the pending card and the
    // history list each show the proposal once, and the editor shows the head.
    expect(text).toContain("Pending proposals");
    expect(text).toContain("Organization company profile");
    expect(text).toContain("Mission: Current mission.");
    expect(text).toContain("Only organization owners and admins can edit or activate");

    const pendingActivate = container.querySelector(
      '[aria-label="Pending company profile proposals"] button',
    );
    expect(pendingActivate?.textContent).toBe("Activate");
    await act(async () => {
      pendingActivate!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(activateCompanyProfileRevision).toHaveBeenCalledTimes(1);
    // A conflict still reloads the single shared inventory so stale CAS values
    // in either surface are replaced before the next action.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "The active company profile changed in another request",
    );
    await act(async () => root.unmount());
  });

  test("tells non-admins who can activate and offers no Activate button", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CompanyProfilePendingProposals
          workspaceId={workspaceId}
          canManage={false}
          inventory={{ response, reload: async () => undefined }}
        />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Mission: Proposed mission from the agent.");
    expect(text).toContain("Only an organization owner or admin can activate this proposal.");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });
});
