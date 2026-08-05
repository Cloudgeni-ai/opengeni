import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  WorkspaceInstructionPolicyOnboardingProposal,
  WorkspaceStateResponse,
} from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const activeRevisionId = "00000000-0000-4000-8000-000000000002";
const listProposals = mock(async () => ({ proposals: [], truncated: false }));
const createProposal = mock(
  async (requestedWorkspaceId: string, request: Record<string, any>) =>
    ({
      id: "00000000-0000-4000-8000-000000000003",
      operationId: request.operationId,
      accountId: "00000000-0000-4000-8000-000000000004",
      workspaceId: requestedWorkspaceId,
      kind: request.kind,
      scope: request.scope,
      roleKey: request.roleKey,
      source: {
        id: request.sourceId,
        version: request.sourceVersion,
        confidenceBps: request.confidenceBps,
      },
      baseline: {
        workspaceId: requestedWorkspaceId,
        kind: "policy",
        scope: "global",
        roleKey: null,
        revisionId: activeRevisionId,
        revision: 7,
        contentHash: "a".repeat(64),
        activationVersion: 3,
        activatedAt: "2026-08-03T18:00:00.000Z",
      },
      draft: {
        id: "00000000-0000-4000-8000-000000000005",
        operationId: request.operationId,
        accountId: "00000000-0000-4000-8000-000000000004",
        workspaceId: requestedWorkspaceId,
        kind: request.kind,
        scope: request.scope,
        roleKey: request.roleKey,
        revision: 8,
        content: request.content,
        contentHash: "b".repeat(64),
        provenance: {
          source: "onboarding",
          sourceId: "00000000-0000-4000-8000-000000000003",
        },
        supersedesRevisionId: activeRevisionId,
        createdBySubjectId: "user:admin",
        createdAt: "2026-08-03T20:00:00.000Z",
      },
      status: "proposed",
      createdBySubjectId: "user:admin",
      createdAt: "2026-08-03T20:00:00.000Z",
    }) satisfies WorkspaceInstructionPolicyOnboardingProposal,
);

const context = {
  client: {
    listWorkspaceInstructionPolicyOnboardingProposals: listProposals,
    createWorkspaceInstructionPolicyOnboardingProposal: createProposal,
  },
  accessContext: {
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["workspace:read", "workspace:admin"] }],
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

const { OnboardingProposalInventory } = await import("./workspace-state");

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

const state = {
  workspaceId,
  generatedAt: "2026-08-03T20:00:00.000Z",
  truth: {
    current: { source: "read_time_projection", capturedAt: "2026-08-03T20:00:00.000Z" },
    attemptGovernance: { status: "not_requested" },
  },
  policy: {
    authority: "workspace_instruction_policy_heads",
    activeHeads: [
      {
        kind: "policy",
        scope: "global",
        roleKey: null,
        revisionId: activeRevisionId,
        revision: 7,
        contentHash: "a".repeat(64),
        activationVersion: 3,
        activatedAt: "2026-08-03T18:00:00.000Z",
      },
    ],
    activeHeadsTruncated: false,
    latestRevision: null,
    legacyRuntime: { source: "deployment_default", workspaceOverrideConfigured: false },
    runtimeComposition: { status: "not_implemented" },
  },
  preferences: {
    authority: "preference_registry_preferences",
    activeDescriptorCount: 0,
    activeDescriptorHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    scopeCounts: { organization: 0, workspace: 0, user: 0 },
    truncated: false,
  },
  knowledge: {
    availability: "unavailable",
    reason: "missing_permission",
    requiredPermission: "documents:search",
  },
} satisfies WorkspaceStateResponse;

describe("Workspace State onboarding proposals", () => {
  test("creates only an inactive draft against the exact displayed baseline", async () => {
    const reloadWorkspaceState = mock(async () => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <OnboardingProposalInventory
            state={state}
            workspaceId={workspaceId}
            onWorkspaceStateReload={reloadWorkspaceState}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain("Proposals never activate themselves");
      expect(container.textContent).toContain("No onboarding proposals exist yet.");

      const selects = container.querySelectorAll<HTMLSelectElement>("select");
      await act(async () => {
        selects[0]!.value = "policy";
        selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.textContent).toContain("Revision r7");
      expect(container.textContent).toContain("Activation v3");
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea,
          "Require explicit confirmation before production mutations.",
        );
        const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
        expect(reactPropsKey).toBeDefined();
        const onChange = (
          textarea as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLTextAreaElement }) => void }
          >
        )[reactPropsKey!]!.onChange;
        expect(typeof onChange).toBe("function");
        onChange!({ target: textarea });
      });
      const form = container.querySelector<HTMLFormElement>(
        'form[aria-label="Create onboarding proposal"]',
      )!;
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });

      expect(createProposal).toHaveBeenCalledTimes(1);
      expect(createProposal.mock.calls[0]?.[0]).toBe(workspaceId);
      expect(createProposal.mock.calls[0]?.[1]).toMatchObject({
        kind: "policy",
        scope: "global",
        roleKey: null,
        content: "Require explicit confirmation before production mutations.",
        sourceId: "guided-onboarding",
        sourceVersion: "v1",
        confidenceBps: 9_000,
        expectedCurrentRevisionId: activeRevisionId,
        expectedActivationVersion: 3,
      });
      expect(container.textContent).toContain("No policy activation occurred.");
      expect(reloadWorkspaceState).toHaveBeenCalledTimes(1);
      expect(listProposals).toHaveBeenCalledWith(workspaceId, { limit: 50 });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
