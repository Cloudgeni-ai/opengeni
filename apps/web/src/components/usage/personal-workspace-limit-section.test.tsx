import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";

const organizationId = "33333333-3333-4333-8333-333333333333";
const reference = "386126c7-51c0-448e-9c5a-56fbec012f9f";

function apiError(status: number, message: string): OpenGeniApiError {
  return new OpenGeniApiError(status, JSON.stringify({ error: { message, requestId: reference } }), {
    mutation: true,
  });
}

let saveFailure: unknown = null;
const client = {
  getOrganizationPrivacySettings: async () => ({
    organizationId,
    defaultVisibility: "workspace",
    personalWorkspaces: true,
    personalWorkspaceMonthlyCredits: null,
    adminsSeePrivateSchedules: true,
    limits: {
      onlyMeAllowed: true,
      defaultVisibilityLocked: false,
      adminsSeePrivateSchedulesLocked: false,
    },
    updatedAt: null,
  }),
  updateOrganizationPrivacySettings: async () => {
    throw saveFailure;
  },
};

mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({ client }),
}));

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

const { PersonalWorkspaceLimitSection, personalLimitErrorText } = await import(
  "./personal-workspace-limit-section"
);

async function setLimitAndSave(): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PersonalWorkspaceLimitSection organizationId={organizationId} />);
  });
  const input = container.querySelector<HTMLInputElement>(
    'input[name="personal-workspace-monthly-limit"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Set limit",
  )!;
  await act(async () => {
    button.click();
  });
  const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
  await act(async () => root.unmount());
  container.remove();
  return alert;
}

describe("Personal workspaces monthly limit", () => {
  test("a server with usage allowances off says what to do, not the raw API error", async () => {
    saveFailure = apiError(
      409,
      "Usage allowance changes are not enabled. Upgrade every API and worker before enabling usage allowances.",
    );
    const alert = await setLimitAndSave();
    expect(alert).toBe(
      "Monthly limits aren't turned on for this deployment yet. Ask whoever runs it to turn them on.",
    );
    expect(alert).not.toContain("API 409");
    expect(alert).not.toContain(reference);
  });

  test("other refusals are plain sentences too", () => {
    expect(personalLimitErrorText(apiError(403, "missing permission: account:admin"))).toBe(
      "Only organization owners and admins can change this limit.",
    );
    const conflict = personalLimitErrorText(apiError(409, "Allowance version or operation conflicts"));
    expect(conflict).not.toMatch(/^API \d{3}/u);
    const failure = personalLimitErrorText(apiError(500, "boom"));
    expect(failure).not.toMatch(/API 500/u);
  });
});
