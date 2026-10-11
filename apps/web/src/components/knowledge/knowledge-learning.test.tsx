import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const records: Record<string, { version: number; settings: Record<string, string> }> = {
  workspace: { version: 4, settings: { knowledge: "automatic", instructions: "review_first" } },
  personal: { version: 1, settings: {} },
};
const saveAgentLearningSettings = mock(
  async (_workspace: string, request: { scope: string; settings: Record<string, string> }) => ({
    ownerKey: request.scope,
    contextKey: "defaults",
    version: records[request.scope]!.version + 1,
    settings: request.settings,
  }),
);
const getCompanyProfileAgentPolicy = mock(async (_workspace: string) => ({
  organizationId: "account-1",
  mode: "suggest" as const,
  version: 3,
  updatedAt: "2026-10-01T00:00:00.000Z",
}));
const updateCompanyProfileAgentPolicy = mock(
  async (
    _workspace: string,
    request: { mode: "off" | "suggest" | "automatic"; expectedVersion: number },
  ) => ({
    organizationId: "account-1",
    mode: request.mode,
    version: request.expectedVersion + 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    changed: true,
  }),
);
const context = {
  client: {
    getAgentLearningSettings: mock(async (_workspace: string, scope: string) => ({
      ownerKey: scope,
      contextKey: "defaults",
      ...records[scope]!,
    })),
    saveAgentLearningSettings,
    getCompanyProfileAgentPolicy,
    updateCompanyProfileAgentPolicy,
  },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: Object.assign(() => 0, { error: () => 0 }) }));
const {
  LearningSettings,
  learningSummary,
  reviewEmptyLine,
  useIdentityLearningPolicy,
  useLearningDefaults,
} = await import("./knowledge-learning");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const openReview = mock(() => undefined);

function Harness({
  canManageWorkspace,
  ownsOrganization = false,
  waiting = null,
  failed = false,
}: {
  canManageWorkspace: boolean;
  ownsOrganization?: boolean;
  waiting?: number | null;
  failed?: boolean;
}) {
  const shared = useLearningDefaults(workspaceId, "workspace");
  const mine = useLearningDefaults(workspaceId, "personal");
  const identity = useIdentityLearningPolicy(workspaceId, ownsOrganization);
  return (
    <LearningSettings
      workspaceName="Design preview"
      organizationName="Acme Robotics"
      personal={false}
      canManageWorkspace={canManageWorkspace}
      shared={shared}
      mine={mine}
      identity={identity}
      review={{ count: waiting, partial: false, failed, onOpen: openReview }}
    />
  );
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

test("one vocabulary, a summary for the menu and a reason on an empty Review", () => {
  expect(learningSummary({ knowledge: "off", instructions: "off", skills: "off" })).toBe("Off");
  expect(
    learningSummary({ knowledge: "automatic", instructions: "review_first", skills: "off" }),
  ).toBe("Mixed");
  expect(
    reviewEmptyLine({
      knowledge: "review_first",
      instructions: "automatic",
      skills: "review_first",
    }),
  ).toBe(
    "Changes agents propose to knowledge and skills wait here for your OK. Agents save other changes on their own.",
  );
  expect(
    reviewEmptyLine({ knowledge: "automatic", instructions: "automatic", skills: "automatic" }),
  ).toContain("so nothing waits here");
});

test("shared and private chats are two labelled groups; a change saves at once", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace />));
    await settle();
    expect(container.textContent).toContain("Shared chats in Design preview");
    expect(container.textContent).toContain("Your private chats (all workspaces)");
    const groups = [...container.querySelectorAll("section")];
    // Private instructions only apply in the Personal workspace, so there is no row for them.
    const privateRows = [...groups[1]!.querySelectorAll("[data-slot=setting-row]")];
    expect(privateRows.map((row) => row.textContent?.startsWith("Instructions"))).not.toContain(
      true,
    );
    expect(privateRows).toHaveLength(2);
    expect(container.textContent).not.toContain("Allow updates");
    const knowledgeReview = [...container.querySelectorAll<HTMLElement>("[role=radio]")].find(
      (radio) =>
        radio.textContent === "Review first" &&
        radio.closest("[data-slot=setting-row]")?.textContent?.includes("Knowledge"),
    );
    expect(knowledgeReview).toBeDefined();
    await act(async () => knowledgeReview!.click());
    await settle();
    expect(saveAgentLearningSettings).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        scope: "workspace",
        expectedVersion: 4,
        settings: { knowledge: "review_first", instructions: "review_first" },
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("people who aren't workspace admins see the shared defaults but can't change them", async () => {
  saveAgentLearningSettings.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace={false} />));
    await settle();
    expect(container.textContent).toContain("Only workspace admins can change this.");
    const shared = container.querySelectorAll("section")[0]!;
    const radios = [...shared.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((radio) => radio.disabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("points per-chat changes at the chat's Agent tab and opens Review from the page", async () => {
  openReview.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace waiting={3} />));
    await settle();
    expect(container.textContent).toContain("Change them in the chat's Agent tab");
    const reviewRow = [
      ...container.querySelectorAll<HTMLElement>("[data-slot=setting-nav-row]"),
    ].find((row) => row.textContent?.includes("Waiting for review"));
    if (!reviewRow) throw new Error("Missing Waiting for review row");
    expect(reviewRow.textContent).toContain("3 waiting");
    await act(async () => reviewRow.querySelector("button")!.click());
    expect(openReview).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("organization owners get an Organization identity row in the same words", async () => {
  getCompanyProfileAgentPolicy.mockClear();
  updateCompanyProfileAgentPolicy.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace ownsOrganization />));
    await settle();
    expect(getCompanyProfileAgentPolicy).toHaveBeenCalledWith(workspaceId);
    expect(container.textContent).toContain("All of Acme Robotics");
    const identityRow = () =>
      [...container.querySelectorAll<HTMLElement>("[data-slot=setting-row]")].find((row) =>
        row.textContent?.startsWith("Organization identity"),
      );
    if (!identityRow()) throw new Error("Missing Organization identity row");
    // `suggest` is Review first here: no "Require approval" anywhere.
    const radios = () => [...identityRow()!.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    expect(radios().map((radio) => radio.textContent)).toEqual([
      "Automatic",
      "Review first",
      "Off",
    ]);
    expect(
      radios().find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent,
    ).toBe("Review first");
    expect(container.textContent).not.toContain("Require approval");
    expect(identityRow()!.textContent).toContain("that owner confirms them in the chat");
    await act(async () =>
      radios()
        .find((radio) => radio.textContent === "Automatic")!
        .click(),
    );
    await settle();
    expect(updateCompanyProfileAgentPolicy).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ mode: "automatic", expectedVersion: 3 }),
    );
    expect(identityRow()!.textContent).toContain("right away");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("people who don't own the organization get no identity row and no policy read", async () => {
  getCompanyProfileAgentPolicy.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace />));
    await settle();
    expect(getCompanyProfileAgentPolicy).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Organization identity");
    expect(container.textContent).not.toContain("All of Acme Robotics");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a Review queue that couldn't be read never says nothing is waiting", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reviewText = () =>
    [...container.querySelectorAll<HTMLElement>("[data-slot=setting-nav-row]")].find((row) =>
      row.textContent?.includes("Waiting for review"),
    )?.textContent ?? "";
  try {
    await act(async () => root.render(<Harness canManageWorkspace waiting={0} />));
    await settle();
    expect(reviewText()).toContain("Nothing waiting");
    await act(async () => root.render(<Harness canManageWorkspace waiting={0} failed />));
    await settle();
    expect(reviewText()).not.toContain("Nothing waiting");
    expect(reviewText()).toContain("Couldn't check");
    await act(async () => root.render(<Harness canManageWorkspace waiting={2} failed />));
    await settle();
    expect(reviewText()).toContain("2+ waiting");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
