import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { VariableSetCard } from "./variable-sets";
import type { WorkspaceVariableSet } from "@/types";

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

describe("Variable Sets credential-autofill boundaries", () => {
  test("uses neutral key/value semantics for add and rotate forms", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <VariableSetCard
            workspaceId="workspace-1"
            variableSet={VARIABLE_SET}
            attachedSessions={[]}
            attachedTasks={[]}
            attachmentsUnknown={false}
            mutating={false}
            onUpdate={async () => VARIABLE_SET}
            onDelete={async () => true}
            onSetVariable={async () => ({})}
            onDeleteVariable={async () => true}
          />,
        );
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Show variables for staging"]')!
          .click();
      });

      const addForm = container.querySelector<HTMLFormElement>(
        'form[aria-label="Add variable to staging"]',
      );
      expect(addForm).not.toBeNull();
      expect(addForm!.getAttribute("autocomplete")).toBe("off");
      expect(addForm!.closest("form")?.getAttribute("aria-label")).toBe("Add variable to staging");
      expect(
        [...addForm!.querySelectorAll<HTMLInputElement>("input")].map((input) => ({
          name: input.name,
          type: input.type,
          autocomplete: input.autocomplete,
        })),
      ).toEqual([
        { name: "variable-name", type: "text", autocomplete: "off" },
        { name: "variable-value", type: "password", autocomplete: "new-password" },
      ]);

      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Rotate")!
          .click();
      });

      const rotateForm = container.querySelector<HTMLFormElement>(
        'form[aria-label="Rotate variable API_TOKEN"]',
      );
      expect(rotateForm).not.toBeNull();
      expect(rotateForm!.getAttribute("autocomplete")).toBe("off");
      expect(rotateForm!.closest("form")?.getAttribute("aria-label")).toBe(
        "Rotate variable API_TOKEN",
      );
      const rotateValue = rotateForm!.querySelector<HTMLInputElement>("input");
      expect(rotateValue).not.toBeNull();
      expect({
        name: rotateValue!.name,
        type: rotateValue!.type,
        autocomplete: rotateValue!.autocomplete,
      }).toEqual({ name: "variable-value", type: "password", autocomplete: "new-password" });

      const variableInputs = [...container.querySelectorAll<HTMLInputElement>("input")];
      expect(variableInputs.map((input) => input.autocomplete)).not.toContain("email");
      expect(variableInputs.map((input) => input.autocomplete)).not.toContain("current-password");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps the managed sign-in fields on their credential autocomplete tokens", async () => {
    const authSource = await Bun.file(`${import.meta.dir}/../context.tsx`).text();

    expect(authSource).toContain('autoComplete="email"');
    expect(authSource).toContain(
      'autoComplete={mode === "signin" ? "current-password" : "new-password"}',
    );
  });
});
