import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ManagedAuthPanel } from "@/components/managed-auth-panel";
import { AddVariableRow } from "@/components/variable-sets/variable-set-forms";
import {
  errorParts,
  usageSummary,
  userFacingError,
} from "@/components/variable-sets/variable-set-model";
import {
  VariableSetDetailPage,
  type VariableSetPageActions,
} from "@/components/variable-sets/variable-set-pages";
import type { Rig, ScheduledTask, Session, WorkspaceVariableSet } from "@/types";

import { sessionUsesVariableSet, variableSetUsage } from "./variable-sets";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const VARIABLE_SET: WorkspaceVariableSet = {
  id: "variable-set-1",
  accountId: "account-1",
  workspaceId: "workspace-1",
  scope: "workspace",
  generation: 1,
  status: "active",
  name: "staging",
  description: "Test-only metadata",
  variables: [
    {
      name: "API_TOKEN",
      version: 2,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
  ],
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const NO_ACTIONS: VariableSetPageActions = {
  back: () => undefined,
  addVariable: async () => undefined,
  pasteEnv: () => undefined,
  replaceValue: () => undefined,
  deleteVariable: () => undefined,
  editSet: () => undefined,
  deleteSet: () => undefined,
  openUsage: () => undefined,
};

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
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
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) onChange({ target: element });
    else element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("Variable sets", () => {
  test("uses the complete ordered session selection before the legacy singular fallback", () => {
    const lowerPrecedenceId = "variable-set-low";
    const higherPrecedenceId = "variable-set-high";

    expect(
      sessionUsesVariableSet(
        {
          variableSetIds: [lowerPrecedenceId, higherPrecedenceId],
          variableSetId: higherPrecedenceId,
        },
        lowerPrecedenceId,
      ),
    ).toBeTrue();
    expect(
      sessionUsesVariableSet({ variableSetId: lowerPrecedenceId }, lowerPrecedenceId),
    ).toBeTrue();
    expect(
      sessionUsesVariableSet(
        { variableSetIds: [], variableSetId: lowerPrecedenceId },
        lowerPrecedenceId,
      ),
    ).toBeFalse();
  });

  test("lists schedules, chats and environment defaults that use a set", () => {
    const session = {
      id: "session-1",
      title: "Deploy staging",
      initialMessage: "Uses staging credentials",
      variableSetIds: ["variable-set-higher", VARIABLE_SET.id],
      variableSetId: "variable-set-higher",
    } as unknown as Session;
    const task = {
      id: "task-1",
      name: "Nightly check",
      status: "paused",
      variableSetId: VARIABLE_SET.id,
    } as unknown as ScheduledTask;
    const rig = {
      id: "rig-1",
      name: "Web app",
      activeVersion: { defaultVariableSetIds: [VARIABLE_SET.id] },
    } as unknown as Rig;
    const usage = variableSetUsage({
      workspaceId: "workspace-1",
      variableSetId: VARIABLE_SET.id,
      sessions: [session],
      tasks: [task],
      rigs: [rig],
      defaultRigId: "rig-1",
      known: true,
    });
    expect(usage.entries.map((entry) => [entry.kind, entry.name, entry.detail])).toEqual([
      ["schedule", "Nightly check", "Paused"],
      ["chat", expect.any(String), undefined],
      ["environment", "Web app", "Added to every new session in this workspace"],
    ]);
    expect(usage.entries[0]!.href).toBe("/workspaces/workspace-1/schedules?taskId=task-1");
    expect(usage.entries[2]!.href).toBe("/workspaces/workspace-1/rigs/rig-1");
    expect(usageSummary(usage.entries)).toBe("1 schedule, 1 chat and 1 environment");
  });

  test("turns API errors into a sentence and keeps the reference apart", () => {
    const parts = errorParts(
      Object.assign(
        new Error("OpenGeni API 409: variable set remains attached. Reference: req_123."),
        { status: 409 },
      ),
    );
    expect(parts).toEqual({
      message: "Variable set remains attached.",
      status: 409,
      reference: "req_123",
    });
  });

  test("a form error says what to do, never the raw API string", () => {
    const error = userFacingError(
      Object.assign(
        new Error("OpenGeni API 403: missing permission: variable_sets:manage Reference: req_403."),
        { status: 403 },
      ),
    );
    expect(error.message).toBe(
      "You don't have permission to do this. Ask an admin for access. Reference: req_403.",
    );
  });

  test("shows variables write-only, with no version, dots or reveal", async () => {
    const view = await render(
      <VariableSetDetailPage
        set={VARIABLE_SET}
        usage={{ known: true, entries: [] }}
        organizationName="Acme"
        canManageSet
        canManageSecrets
        actions={NO_ACTIONS}
      />,
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("API_TOKEN");
      expect(text).toContain("Secret");
      expect(text).not.toContain("v2");
      expect(text).not.toContain("••••••");
      expect(text).not.toMatch(/Reveal|Rotate|Revoke/u);
      expect(
        view.container.querySelector('button[aria-label="Actions for API_TOKEN"]'),
      ).not.toBeNull();
      expect(
        view.container.querySelector('button[aria-label="More actions for staging"]'),
      ).not.toBeNull();
      expect(
        view.container.querySelector('form[aria-label="Add a variable to staging"]'),
      ).not.toBeNull();
      expect(text).toContain("Paste .env");
      expect(text).not.toContain("Add variable");
    } finally {
      await view.cleanup();
    }
  });

  test("hides every change without the matching permission", async () => {
    const view = await render(
      <VariableSetDetailPage
        set={{ ...VARIABLE_SET, scope: "organization" }}
        usage={{ known: true, entries: [] }}
        organizationName="Acme"
        canManageSet={false}
        canManageSecrets={false}
        actions={NO_ACTIONS}
      />,
    );
    try {
      expect(view.container.querySelector('button[aria-label="Actions for API_TOKEN"]')).toBeNull();
      expect(
        view.container.querySelector('button[aria-label="More actions for staging"]'),
      ).toBeNull();
      expect(view.container.querySelector("form")).toBeNull();
      expect(view.container.textContent).not.toContain("Paste .env");
      expect(view.container.textContent).not.toContain("Delete variable set");
      expect(view.container.textContent).toContain("Only organization admins can change it.");
    } finally {
      await view.cleanup();
    }
  });

  test("adds variables inline: uppercases live, explains errors, then clears for the next", async () => {
    const added: Array<{ name: string; value: string }> = [];
    const view = await render(
      <AddVariableRow
        set={VARIABLE_SET}
        onPaste={() => undefined}
        onAdd={async (variable) => {
          added.push(variable);
        }}
      />,
    );
    try {
      const name = () =>
        view.container.querySelector<HTMLInputElement>('input[name="variable-name"]')!;
      const value = () =>
        view.container.querySelector<HTMLInputElement>('input[name="variable-value"]')!;
      const submit = async () => {
        await act(async () => {
          view.container.querySelector("form")!.requestSubmit();
        });
        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        });
      };
      expect(name().autocomplete).toBe("off");

      await setInputValue(name(), "github token");
      expect(name().value).toBe("GITHUB_TOKEN");
      expect(view.container.textContent).toContain("Opengeni sets GITHUB_TOKEN");

      await setInputValue(name(), "api_token");
      expect(view.container.textContent).toContain("API_TOKEN is already in this set");

      await setInputValue(name(), "test-key");
      expect(name().value).toBe("TEST_KEY");
      await submit();
      expect(view.container.textContent).toContain("Enter a value.");
      expect(added).toEqual([]);

      await setInputValue(value(), "secret-value");
      await submit();
      expect(added).toEqual([{ name: "TEST_KEY", value: "secret-value" }]);
      expect(name().value).toBe("");
      expect(value().value).toBe("");
      expect(document.activeElement).toBe(name());
      expect(view.container.textContent).not.toContain("Enter a value.");

      await setInputValue(name(), "region");
      await setInputValue(value(), "eu-north-1");
      await submit();
      expect(added.at(-1)).toEqual({ name: "REGION", value: "eu-north-1" });
    } finally {
      await view.cleanup();
    }
  });

  test("keeps the managed sign-in fields on their credential autocomplete tokens", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ManagedAuthPanel emailVerificationRequired={false} onSubmit={async () => undefined} />,
        );
      });

      const email = container.querySelector<HTMLInputElement>("#managed-auth-email");
      expect(email).not.toBeNull();
      expect({ type: email!.type, autocomplete: email!.autocomplete }).toEqual({
        type: "email",
        autocomplete: "email",
      });

      const signInPassword = container.querySelector<HTMLInputElement>("#managed-auth-password");
      expect(signInPassword).not.toBeNull();
      expect({ type: signInPassword!.type, autocomplete: signInPassword!.autocomplete }).toEqual({
        type: "password",
        autocomplete: "current-password",
      });

      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Sign up")!
          .click();
      });

      const signUpPassword = container.querySelector<HTMLInputElement>("#managed-auth-password");
      expect(signUpPassword).not.toBeNull();
      expect({ type: signUpPassword!.type, autocomplete: signUpPassword!.autocomplete }).toEqual({
        type: "password",
        autocomplete: "new-password",
      });
      expect(container.querySelector<HTMLInputElement>("#managed-auth-name")?.autocomplete).toBe(
        "name",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
