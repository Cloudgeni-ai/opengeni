import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AccessContext, CompanyProfileListResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const subjectId = "user:organization-admin";

const inventory: CompanyProfileListResponse = {
  current: null,
  activeRevision: null,
  revisions: [],
  activationEvents: [],
  nextAfterRevision: null,
};

const listCompanyProfile = mock(async () => inventory);
const reloadCompanyProfile = mock(async () => undefined);
const activateCompanyProfileRevision = mock(async () => ({}));
const rollbackCompanyProfile = mock(async () => ({}));
const updateCompanyProfile = mock(async (_workspaceId: string, request: Record<string, any>) => ({
  revision: {
    id: "00000000-0000-4000-8000-000000000003",
    operationId: request.operationId,
    accountId,
    revision: 1,
    contentHash: "a".repeat(64),
    intent: "active" as const,
    profile: request.profile,
    provenance: { source: "human" as const, sourceId: null },
    supersedesRevisionId: null,
    createdBySubjectId: subjectId,
    createdAt: "2026-08-22T08:00:00.000Z",
  },
  head: null,
  event: null,
}));

function accessContext(
  role: "owner" | "admin" | "member",
  principalKind: AccessContext["workspaceGrants"][number]["principalKind"] = "human_session",
): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [{ accountId, subjectId, role, permissions: ["account:read"] }],
    workspaceGrants: [
      {
        workspaceId,
        accountId,
        subjectId,
        permissions: ["workspace:read", "workspace:admin"],
        principalKind,
      },
    ],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
}

const context: {
  client: Record<string, unknown>;
  accessContext: AccessContext;
} = {
  client: {
    listCompanyProfile,
    updateCompanyProfile,
    activateCompanyProfileRevision,
    rollbackCompanyProfile,
  },
  accessContext: accessContext("admin"),
};

mock.module("@/context", () => ({ useAppContext: () => context }));
const { CompanyProfileInventory } = await import("./workspace-state");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  context.accessContext = accessContext("admin");
  listCompanyProfile.mockClear();
  reloadCompanyProfile.mockClear();
  updateCompanyProfile.mockClear();
  activateCompanyProfileRevision.mockClear();
  rollbackCompanyProfile.mockClear();
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function renderInventory(response: CompanyProfileListResponse = inventory) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CompanyProfileInventory
        workspaceId={workspaceId}
        inventory={{
          response,
          reload: reloadCompanyProfile,
          loading: false,
          error: null,
        }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function setValue(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
      element,
      value,
    );
    const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          element as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLTextAreaElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) onChange({ target: element });
    else element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("organization company-profile manual editor", () => {
  test("lets a direct organization admin edit and activate without account:admin", async () => {
    const { container, root } = await renderInventory();
    try {
      const form = container.querySelector<HTMLFormElement>(
        'form[aria-label="Edit organization company profile"]',
      );
      expect(form).not.toBeNull();
      const identity = form!.querySelector<HTMLTextAreaElement>("textarea");
      await setValue(identity!, "CloudGeni builds OpenGeni.");
      await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(updateCompanyProfile).toHaveBeenCalledTimes(1);
      expect(updateCompanyProfile.mock.calls[0]?.[0]).toBe(workspaceId);
      expect(updateCompanyProfile.mock.calls[0]?.[1]).toMatchObject({
        profile: { identity: "CloudGeni builds OpenGeni." },
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps members and non-human principals read-only with an accurate explanation", async () => {
    const delegatedHuman = accessContext("admin");
    delegatedHuman.workspaceGrants[0]!.metadata = { delegated: true };
    const duplicateAccountGrant = accessContext("admin");
    duplicateAccountGrant.accountGrants.push({ ...duplicateAccountGrant.accountGrants[0]! });
    const otherSubjectAccountGrant = accessContext("admin");
    otherSubjectAccountGrant.accountGrants.push({
      ...otherSubjectAccountGrant.accountGrants[0]!,
      subjectId: "user:other-organization-admin",
    });
    const duplicateWorkspaceGrant = accessContext("admin");
    duplicateWorkspaceGrant.workspaceGrants.push({
      ...duplicateWorkspaceGrant.workspaceGrants[0]!,
    });
    for (const deniedContext of [
      accessContext("member"),
      accessContext("admin", "agent_attempt"),
      delegatedHuman,
      duplicateAccountGrant,
      otherSubjectAccountGrant,
      duplicateWorkspaceGrant,
    ]) {
      context.accessContext = deniedContext;
      const { container, root } = await renderInventory();
      try {
        expect(
          container.querySelector('form[aria-label="Edit organization company profile"]'),
        ).toBeNull();
        expect(container.textContent).toContain(
          "Editing, activation, and rollback require a direct organization owner or admin session.",
        );
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  });

  test("shows a server-side revocation error and re-enables the save control", async () => {
    updateCompanyProfile.mockImplementationOnce(async () => {
      throw new Error(
        "Company-profile administration requires organization owner or admin authority",
      );
    });
    const { container, root } = await renderInventory();
    try {
      const form = container.querySelector<HTMLFormElement>(
        'form[aria-label="Edit organization company profile"]',
      )!;
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).toContain("organization owner or admin authority");
      expect(button.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("lets a direct organization owner activate a proposal without account:admin", async () => {
    context.accessContext = accessContext("owner");
    const proposalId = "00000000-0000-4000-8000-000000000010";
    const currentId = "00000000-0000-4000-8000-000000000011";
    const response: CompanyProfileListResponse = {
      current: {
        accountId,
        revisionId: currentId,
        revision: 1,
        contentHash: "a".repeat(64),
        activationVersion: 2,
        activatedAt: "2026-08-22T08:00:00.000Z",
      },
      activeRevision: {
        id: currentId,
        operationId: "00000000-0000-4000-8000-000000000012",
        accountId,
        revision: 1,
        contentHash: "a".repeat(64),
        intent: "active",
        profile: {
          identity: "Current profile",
          mission: null,
          products: [],
          customers: [],
          goals: [],
          constraints: [],
        },
        provenance: { source: "human", sourceId: null },
        supersedesRevisionId: null,
        createdBySubjectId: subjectId,
        createdAt: "2026-08-22T08:00:00.000Z",
      },
      revisions: [
        {
          id: proposalId,
          operationId: "00000000-0000-4000-8000-000000000013",
          accountId,
          revision: 2,
          contentHash: "b".repeat(64),
          intent: "proposal",
          profile: {
            identity: "Proposed profile",
            mission: null,
            products: [],
            customers: [],
            goals: [],
            constraints: [],
          },
          provenance: { source: "agent_admin", sourceId: "agent-admin-proposal:test" },
          supersedesRevisionId: currentId,
          createdBySubjectId: "agent:test",
          createdAt: "2026-08-22T08:10:00.000Z",
        },
      ],
      activationEvents: [],
      nextAfterRevision: null,
    };
    const { container, root } = await renderInventory(response);
    try {
      const activate = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Activate",
      );
      expect(activate).not.toBeUndefined();
      await act(async () => {
        activate!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(activateCompanyProfileRevision).toHaveBeenCalledTimes(1);
      expect(activateCompanyProfileRevision.mock.calls[0]).toMatchObject([
        workspaceId,
        proposalId,
        { expectedCurrentRevisionId: currentId, expectedActivationVersion: 2 },
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("lets a direct organization admin roll back a previously active revision", async () => {
    const currentId = "00000000-0000-4000-8000-000000000020";
    const previousId = "00000000-0000-4000-8000-000000000021";
    const response: CompanyProfileListResponse = {
      current: {
        accountId,
        revisionId: currentId,
        revision: 2,
        contentHash: "c".repeat(64),
        activationVersion: 3,
        activatedAt: "2026-08-22T08:20:00.000Z",
      },
      activeRevision: {
        id: currentId,
        operationId: "00000000-0000-4000-8000-000000000022",
        accountId,
        revision: 2,
        contentHash: "c".repeat(64),
        intent: "active",
        profile: {
          identity: "Current profile",
          mission: null,
          products: [],
          customers: [],
          goals: [],
          constraints: [],
        },
        provenance: { source: "human", sourceId: null },
        supersedesRevisionId: previousId,
        createdBySubjectId: subjectId,
        createdAt: "2026-08-22T08:20:00.000Z",
      },
      revisions: [
        {
          id: currentId,
          operationId: "00000000-0000-4000-8000-000000000022",
          accountId,
          revision: 2,
          contentHash: "c".repeat(64),
          intent: "active",
          profile: {
            identity: "Current profile",
            mission: null,
            products: [],
            customers: [],
            goals: [],
            constraints: [],
          },
          provenance: { source: "human", sourceId: null },
          supersedesRevisionId: previousId,
          createdBySubjectId: subjectId,
          createdAt: "2026-08-22T08:20:00.000Z",
        },
        {
          id: previousId,
          operationId: "00000000-0000-4000-8000-000000000023",
          accountId,
          revision: 1,
          contentHash: "d".repeat(64),
          intent: "active",
          profile: {
            identity: "Previous profile",
            mission: null,
            products: [],
            customers: [],
            goals: [],
            constraints: [],
          },
          provenance: { source: "human", sourceId: null },
          supersedesRevisionId: null,
          createdBySubjectId: subjectId,
          createdAt: "2026-08-22T08:00:00.000Z",
        },
      ],
      activationEvents: [
        {
          id: "00000000-0000-4000-8000-000000000024",
          operationId: "00000000-0000-4000-8000-000000000025",
          accountId,
          type: "activate",
          activationVersion: 1,
          oldRevision: null,
          newRevision: { id: previousId, revision: 1, contentHash: "d".repeat(64) },
          actorSubjectId: subjectId,
          reason: "Initial activation",
          createdAt: "2026-08-22T08:00:00.000Z",
        },
      ],
      nextAfterRevision: null,
    };
    const { container, root } = await renderInventory(response);
    try {
      const rollback = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Rollback",
      );
      expect(rollback).not.toBeUndefined();
      await act(async () => {
        rollback!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(rollbackCompanyProfile).toHaveBeenCalledTimes(1);
      expect(rollbackCompanyProfile.mock.calls[0]).toMatchObject([
        workspaceId,
        {
          targetRevisionId: previousId,
          expectedCurrentRevisionId: currentId,
          expectedActivationVersion: 3,
        },
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
