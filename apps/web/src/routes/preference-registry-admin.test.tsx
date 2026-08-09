import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  OpenGeniApiError,
  type PreferenceRegistryDetailResponse,
  type PreferenceRegistryMutationResponse,
  type PreferenceRegistryRecord,
} from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const preferenceId = "00000000-0000-4000-8000-000000000003";
const revisionOneId = "00000000-0000-4000-8000-000000000004";
const revisionTwoId = "00000000-0000-4000-8000-000000000005";
const replacementPreferenceId = "00000000-0000-4000-8000-000000000010";
const replacementRevisionId = "00000000-0000-4000-8000-000000000011";

const revisionOne = {
  id: revisionOneId,
  preferenceId,
  revision: 1,
  contentHash: "a".repeat(64),
  title: "Concise recommendations",
  description: "Begin recommendations with a direct answer.",
  precedence: {
    tier: "workspace" as const,
    rank: 10,
    conflictStrategy: "override" as const,
    conflictsWith: [],
  },
  provenance: {
    source: "human" as const,
    sourceId: null,
    trust: "workspace_managed" as const,
  },
  expiresAt: null,
  correctsRevisionId: null,
  createdBySubjectId: "user:admin",
  createdAt: "2026-08-08T10:00:00.000Z",
};

const revisionTwo = {
  ...revisionOne,
  id: revisionTwoId,
  revision: 2,
  contentHash: "b".repeat(64),
  description: "Lead with one direct recommendation before supporting detail.",
  correctsRevisionId: revisionOneId,
  createdAt: "2026-08-08T11:00:00.000Z",
};

const preference: PreferenceRegistryRecord = {
  id: preferenceId,
  accountId,
  stableKey: "response.recommendation",
  target: { scope: "workspace" as const, workspaceId, subjectId: null },
  status: "active" as const,
  scopeVersion: 3,
  activationVersion: 2,
  activeRevision: revisionTwo,
  supersededByPreferenceId: null,
  createdBySubjectId: "user:admin",
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-08T11:00:00.000Z",
};

const replacementRevision = {
  ...revisionTwo,
  id: replacementRevisionId,
  preferenceId: replacementPreferenceId,
  revision: 1,
  contentHash: "c".repeat(64),
  title: "Evidence-first recommendations",
  description: "Use the replacement recommendation format.",
  correctsRevisionId: null,
};

const replacementPreference: PreferenceRegistryRecord = {
  ...preference,
  id: replacementPreferenceId,
  stableKey: "response.recommendation-v2",
  scopeVersion: 1,
  activationVersion: 1,
  activeRevision: replacementRevision,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const detail = {
  preference,
  revisions: [revisionOne, revisionTwo],
  events: [
    {
      id: "00000000-0000-4000-8000-000000000006",
      accountId,
      preferenceId,
      type: "proposal_created",
      version: 1,
      oldRevisionId: null,
      newRevisionId: revisionOneId,
      oldTarget: null,
      newTarget: preference.target,
      relatedPreferenceId: null,
      actorSubjectId: "user:admin",
      reason: "Human-created preference proposal; inactive pending activation",
      createdAt: "2026-08-08T10:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000007",
      accountId,
      preferenceId,
      type: "corrected",
      version: 2,
      oldRevisionId: revisionOneId,
      newRevisionId: revisionTwoId,
      oldTarget: preference.target,
      newTarget: preference.target,
      relatedPreferenceId: null,
      actorSubjectId: "user:admin",
      reason: "Clarify the descriptor",
      createdAt: "2026-08-08T11:00:00.000Z",
    },
  ],
} satisfies PreferenceRegistryDetailResponse;

const listPreferenceRegistry = mock(
  async (): Promise<{ preferences: PreferenceRegistryRecord[] }> => ({
    preferences: [preference],
  }),
);
const getPreferenceRegistry = mock(async (): Promise<PreferenceRegistryDetailResponse> => detail);
const createPreferenceRegistryProposal = mock(async (_workspaceId: string, request: any) => ({
  ...preference,
  id: "00000000-0000-4000-8000-000000000008",
  stableKey: request.stableKey,
  target: {
    scope: request.scope,
    workspaceId: request.scope === "workspace" ? workspaceId : null,
    subjectId: request.scope === "user" ? "user:admin" : null,
  },
  status: "proposed" as const,
  scopeVersion: 1,
  activationVersion: 0,
  activeRevision: null,
}));
const activatePreferenceRegistryRevision = mock(
  async (
    _workspaceId: string,
    _preferenceId: string,
    _request: Record<string, unknown>,
  ): Promise<PreferenceRegistryMutationResponse> => ({
    preference: { ...preference, activeRevision: revisionOne, activationVersion: 3 },
    event: {
      ...detail.events[1]!,
      id: "00000000-0000-4000-8000-000000000009",
      type: "activated",
      version: 3,
      oldRevisionId: revisionTwoId,
      newRevisionId: revisionOneId,
      reason: "Restore the simpler revision",
      createdAt: "2026-08-09T12:00:00.000Z",
    },
  }),
);
const correctPreferenceRegistry = mock(
  async (_workspaceId: string, _preferenceId: string, _request: Record<string, unknown>) => ({
    preference,
    event: detail.events[1]!,
  }),
);
const changePreferenceRegistryScope = mock(async () => ({
  preference,
  event: detail.events[1]!,
}));
const deactivatePreferenceRegistry = mock(async () => ({
  preference,
  event: detail.events[1]!,
}));
const supersedePreferenceRegistry = mock(
  async (_workspaceId: string, _preferenceId: string, _request: Record<string, unknown>) => ({
    preference: {
      ...preference,
      status: "superseded" as const,
      supersededByPreferenceId: replacementPreferenceId,
    },
    event: {
      ...detail.events[1]!,
      type: "superseded" as const,
      relatedPreferenceId: replacementPreferenceId,
    },
  }),
);
const rejectPreferenceRegistryProposal = mock(async () => ({
  preference,
  event: detail.events[1]!,
}));

const appContext: Record<string, any> = {
  client: {
    listPreferenceRegistry,
    getPreferenceRegistry,
    createPreferenceRegistryProposal,
    activatePreferenceRegistryRevision,
    correctPreferenceRegistry,
    changePreferenceRegistryScope,
    deactivatePreferenceRegistry,
    supersedePreferenceRegistry,
    rejectPreferenceRegistryProposal,
  },
  authSession: { user: { id: "user:admin" } },
  accessContext: {
    mode: "managed",
    subjectId: "user:admin",
    accountGrants: [
      {
        accountId,
        subjectId: "user:admin",
        permissions: ["account:admin"],
      },
    ],
    workspaceGrants: [
      {
        accountId,
        workspaceId,
        subjectId: "user:admin",
        principalKind: "human_session",
        permissions: ["workspace:read", "workspace:admin"],
      },
    ],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  },
};

mock.module("@/context", () => ({
  useAppContext: () => appContext,
}));

const { PreferenceRegistryAdministration } = await import("./preference-registry-admin");

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  for (const operation of [
    listPreferenceRegistry,
    getPreferenceRegistry,
    createPreferenceRegistryProposal,
    activatePreferenceRegistryRevision,
    correctPreferenceRegistry,
    changePreferenceRegistryScope,
    deactivatePreferenceRegistry,
    supersedePreferenceRegistry,
    rejectPreferenceRegistryProposal,
  ]) {
    operation.mockClear();
  }
  appContext.authSession = { user: { id: "user:admin" } };
  appContext.accessContext.accountGrants[0].permissions = ["account:admin"];
  appContext.accessContext.workspaceGrants[0].principalKind = "human_session";
  appContext.accessContext.workspaceGrants[0].permissions = ["workspace:read", "workspace:admin"];
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          element as unknown as Record<
            string,
            { onChange?: (event: { target: typeof element }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) {
      onChange({ target: element });
    } else {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
  });
}

async function setChecked(element: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(
      element,
      checked,
    );
    const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          element as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) {
      onChange({ target: element });
    } else {
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
  });
}

function controlForLabel<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  container: HTMLElement,
  labelText: string,
): T {
  const label = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(labelText),
  );
  const control = label?.querySelector("input, textarea, select") as T | null;
  if (!control) throw new Error(`Missing control for label ${labelText}`);
  return control;
}

describe("structured preference Workspace State administration", () => {
  test("shows descriptors, on-demand content boundaries, versions, provenance, and audit history", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={async () => undefined}
          />,
        ),
      );
      await settle();
      await settle();

      expect(container.textContent).toContain("dedicated organization/workspace/personal registry");
      expect(container.textContent).toContain("not ordinary Memory");
      expect(container.textContent).toContain("Organization");
      expect(container.textContent).toContain("Workspace");
      expect(container.textContent).toContain("Personal");
      expect(container.textContent).toContain("Compact descriptor");
      expect(container.textContent).toContain(revisionTwo.description);
      expect(container.textContent).toContain("Full content stays on demand");
      expect(container.textContent).toContain("preference_registry_summary");
      expect(container.textContent).toContain("preference_registry_get");
      expect(container.textContent).toContain("Rank 10");
      expect(container.textContent).toContain("Trust: Workspace managed");
      expect(container.textContent).toContain("Scope v3 · activation v2");
      expect(container.textContent).toContain("Revision r1");
      expect(container.textContent).toContain("Revision r2");
      expect(container.textContent).toContain("Immutable lifecycle audit");
      expect(container.textContent).toContain("Clarify the descriptor");
      expect(container.textContent).toContain("Actor: user:admin");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("creates an explicitly scoped inactive human proposal", async () => {
    const reloadWorkspaceState = mock(async () => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={reloadWorkspaceState}
          />,
        ),
      );
      await settle();

      const form = container.querySelector<HTMLFormElement>(
        'form[aria-label="Create structured preference proposal"]',
      )!;
      await setValue(controlForLabel(form, "Authority scope"), "organization");
      await setValue(controlForLabel(form, "Stable key"), "support.response-format");
      await setValue(controlForLabel(form, "Descriptor title"), "Support response format");
      await setValue(
        controlForLabel(form, "Compact descriptor"),
        "Use a short recommendation before evidence.",
      );
      await setValue(
        controlForLabel(form, "Full preference content"),
        "Begin every support recommendation with one concise sentence, then provide evidence.",
      );
      await setValue(controlForLabel(form, "Precedence rank"), "25");

      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await settle();

      expect(createPreferenceRegistryProposal).toHaveBeenCalledTimes(1);
      expect(createPreferenceRegistryProposal.mock.calls[0]?.[0]).toBe(workspaceId);
      expect(createPreferenceRegistryProposal.mock.calls[0]?.[1]).toMatchObject({
        stableKey: "support.response-format",
        scope: "organization",
        title: "Support response format",
        description: "Use a short recommendation before evidence.",
        content:
          "Begin every support recommendation with one concise sentence, then provide evidence.",
        precedenceRank: 25,
        conflictStrategy: "override",
        provenanceSource: "human",
        provenanceSourceId: null,
      });
      expect(container.textContent).toContain(
        "Organization proposal created inactive. No prompt behavior changed.",
      );
      expect(reloadWorkspaceState).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("rolls back by activating an older immutable revision with exact CAS fields", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={async () => undefined}
          />,
        ),
      );
      await settle();
      await settle();

      await setValue(controlForLabel(container, "Audit reason"), "Restore the simpler revision");
      const confirmation = [
        ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((candidate) =>
        candidate.parentElement?.textContent?.includes("newly accepted attempts"),
      )!;
      await setChecked(confirmation, true);
      const rollback = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Roll back to r1",
      )!;

      await act(async () => {
        rollback.click();
        await Promise.resolve();
      });
      await settle();

      expect(activatePreferenceRegistryRevision).toHaveBeenCalledTimes(1);
      expect(activatePreferenceRegistryRevision.mock.calls[0]).toEqual([
        workspaceId,
        preferenceId,
        {
          revisionId: revisionOneId,
          expectedCurrentRevisionId: revisionTwoId,
          expectedScopeVersion: 3,
          reason: "Restore the simpler revision",
        },
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("labels superseded and expired retained heads as non-authoritative", async () => {
    for (const status of ["superseded", "expired"] as const) {
      const retainedPreference = {
        ...preference,
        status,
        supersededByPreferenceId:
          status === "superseded" ? replacementPreferenceId : preference.supersededByPreferenceId,
      } satisfies PreferenceRegistryRecord;
      listPreferenceRegistry.mockResolvedValueOnce({ preferences: [retainedPreference] });
      getPreferenceRegistry.mockResolvedValueOnce({
        ...detail,
        preference: retainedPreference,
      });
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <PreferenceRegistryAdministration
              workspaceId={workspaceId}
              onWorkspaceStateReload={async () => undefined}
            />,
          ),
        );
        await settle();
        await settle();

        expect(container.textContent).toContain("Retained head descriptor");
        expect(container.textContent).toContain("excluded from current descriptor authority");
        expect(container.textContent).toContain("Retained head · not current authority");
        expect(
          [...container.querySelectorAll("span")].some(
            (candidate) => candidate.textContent?.trim() === "Active",
          ),
        ).toBe(false);
        if (status === "superseded") {
          expect(container.textContent).toContain(
            `Superseded by replacement preference: ${replacementPreferenceId}`,
          );
        }
      } finally {
        await act(async () => root.unmount());
      }
    }
  });

  test("supersedes an active preference with typed replacement lineage and exact CAS fields", async () => {
    listPreferenceRegistry.mockResolvedValueOnce({
      preferences: [preference, replacementPreference],
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={async () => undefined}
          />,
        ),
      );
      await settle();
      await settle();

      const replacement = controlForLabel<HTMLSelectElement>(
        container,
        "Active same-scope replacement",
      );
      expect(replacement.value).toBe(replacementPreferenceId);
      await setValue(controlForLabel(container, "Audit reason"), "Replace the old preference");
      const confirmation = [
        ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((candidate) =>
        candidate.parentElement?.textContent?.includes("newly accepted attempts"),
      )!;
      await setChecked(confirmation, true);
      const supersede = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Supersede with replacement",
      )!;

      await act(async () => {
        supersede.click();
        await Promise.resolve();
      });
      await settle();

      expect(supersedePreferenceRegistry).toHaveBeenCalledTimes(1);
      expect(supersedePreferenceRegistry.mock.calls[0]).toEqual([
        workspaceId,
        preferenceId,
        {
          replacementPreferenceId,
          expectedCurrentRevisionId: revisionTwoId,
          expectedScopeVersion: 3,
          reason: "Replace the old preference",
        },
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("reports stable-key conflicts distinctly from stale lifecycle CAS conflicts", async () => {
    createPreferenceRegistryProposal.mockRejectedValueOnce(
      new OpenGeniApiError(
        409,
        JSON.stringify({
          code: "PREFERENCE_REGISTRY_STABLE_KEY_CONFLICT",
          message: "A preference with this stable key already exists for the target scope",
        }),
        { mutation: true },
      ),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={async () => undefined}
          />,
        ),
      );
      await settle();

      const form = container.querySelector<HTMLFormElement>(
        'form[aria-label="Create structured preference proposal"]',
      )!;
      await setValue(controlForLabel(form, "Stable key"), preference.stableKey);
      await setValue(controlForLabel(form, "Descriptor title"), "Duplicate preference");
      await setValue(controlForLabel(form, "Compact descriptor"), "Duplicate descriptor.");
      await setValue(controlForLabel(form, "Full preference content"), "Duplicate body.");
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await settle();

      expect(container.textContent).toContain(
        "A preference with this stable key already exists in the requested scope.",
      );
      expect(container.textContent).not.toContain("changed in another request");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("reports stale lifecycle CAS distinctly and refreshes inventory plus selected detail", async () => {
    deactivatePreferenceRegistry.mockRejectedValueOnce(
      new OpenGeniApiError(
        409,
        JSON.stringify({
          code: "PREFERENCE_REGISTRY_CONFLICT",
          message: "The active preference revision changed before deactivation",
          currentRevisionId: revisionOneId,
          scopeVersion: 4,
        }),
        { mutation: true },
      ),
    );
    const reloadWorkspaceState = mock(async () => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={reloadWorkspaceState}
          />,
        ),
      );
      await settle();
      await settle();
      expect(listPreferenceRegistry).toHaveBeenCalledTimes(1);
      expect(getPreferenceRegistry).toHaveBeenCalledTimes(1);

      await setValue(controlForLabel(container, "Audit reason"), "Deactivate stale revision");
      const confirmation = [
        ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((candidate) =>
        candidate.parentElement?.textContent?.includes("newly accepted attempts"),
      )!;
      await setChecked(confirmation, true);
      const deactivate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Deactivate",
      )!;
      await act(async () => {
        deactivate.click();
        await Promise.resolve();
      });
      await settle();
      expect(container.textContent).toContain(
        "The preference changed in another request. Refresh the registry and selected detail",
      );

      const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Refresh registry and detail"),
      )!;
      await act(async () => {
        refresh.click();
        await Promise.resolve();
      });
      await settle();

      expect(listPreferenceRegistry).toHaveBeenCalledTimes(2);
      expect(getPreferenceRegistry).toHaveBeenCalledTimes(2);
      expect(reloadWorkspaceState).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("The preference changed in another request");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("requires accepted-attempt boundary confirmation before activating a correction", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={async () => undefined}
          />,
        ),
      );
      await settle();
      await settle();

      const form = container.querySelector<HTMLFormElement>(
        'form[aria-label="Correct structured preference"]',
      )!;
      await setValue(controlForLabel(form, "Complete replacement content"), "Corrected body.");
      await setValue(controlForLabel(form, "Correction reason"), "Correct the active content");
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await settle();

      expect(correctPreferenceRegistry).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        "Confirm that this correction changes authority only for newly accepted attempts.",
      );

      const confirmation = [
        ...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((candidate) =>
        candidate.parentElement?.textContent?.includes("correction immediately activates"),
      )!;
      await setChecked(confirmation, true);
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await settle();

      expect(correctPreferenceRegistry).toHaveBeenCalledTimes(1);
      expect(correctPreferenceRegistry.mock.calls[0]?.[2]).toMatchObject({
        expectedCurrentRevisionId: revisionTwoId,
        expectedScopeVersion: 3,
        content: "Corrected body.",
        reason: "Correct the active content",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("keeps configured-key and service-like contexts read only", async () => {
    appContext.authSession = null;
    appContext.accessContext.accountGrants[0].permissions = [];
    appContext.accessContext.workspaceGrants[0].principalKind = "configured_key";
    appContext.accessContext.workspaceGrants[0].permissions = ["workspace:read", "workspace:admin"];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PreferenceRegistryAdministration
            workspaceId={workspaceId}
            onWorkspaceStateReload={async () => undefined}
          />,
        ),
      );
      await settle();
      await settle();

      expect(container.textContent).toContain("Direct human session required");
      expect(container.textContent).toContain(
        "API keys, workers, services, and agent attempts are read only here.",
      );
      const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.includes("Create inactive proposal"),
      );
      expect(createButton?.disabled).toBe(true);
      expect(container.textContent).toContain("lifecycle changes require a direct signed-in human");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
