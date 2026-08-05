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
            canWriteSet={true}
            canWriteSecrets={true}
            canReadSecrets={true}
            revealEpoch={0}
            onUpdate={async () => VARIABLE_SET}
            onDelete={async () => true}
            onReadVariable={async (name) => ({
              variableSetId: VARIABLE_SET.id,
              name,
              version: 2,
              value: "test-value",
            })}
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
        {
          name: "variable-value",
          type: "password",
          autocomplete: "new-password",
        },
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
      }).toEqual({
        name: "variable-value",
        type: "password",
        autocomplete: "new-password",
      });

      const variableInputs = [...container.querySelectorAll<HTMLInputElement>("input")];
      expect(variableInputs.map((input) => input.autocomplete)).not.toContain("email");
      expect(variableInputs.map((input) => input.autocomplete)).not.toContain("current-password");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("reveals and copies only on demand, then clears plaintext on hide and refresh", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const exact = `const fake = "ghp_not_a_credential";\nprintf '%s\\n' "$VALUE"`;
    const copies: string[] = [];
    let reads = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copies.push(value);
        },
      },
    });
    const renderCard = async (revealEpoch: number) => {
      await act(async () => {
        root.render(
          <VariableSetCard
            workspaceId="workspace-1"
            variableSet={VARIABLE_SET}
            attachedSessions={[]}
            attachedTasks={[]}
            attachmentsUnknown={false}
            mutating={false}
            canWriteSet={true}
            canWriteSecrets={true}
            canReadSecrets={true}
            revealEpoch={revealEpoch}
            onUpdate={async () => VARIABLE_SET}
            onDelete={async () => true}
            onReadVariable={async (name) => {
              reads += 1;
              return {
                variableSetId: VARIABLE_SET.id,
                name,
                version: 2,
                value: exact,
              };
            }}
            onSetVariable={async () => ({})}
            onDeleteVariable={async () => true}
          />,
        );
      });
    };

    try {
      await renderCard(0);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Show variables for staging"]')!
          .click();
      });
      expect(container.textContent).not.toContain(exact);
      expect(reads).toBe(0);

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Reveal variable API_TOKEN"]')!
          .click();
      });
      expect(reads).toBe(1);
      expect(container.textContent).toContain(exact);

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Copy variable API_TOKEN"]')!
          .click();
      });
      expect(copies).toEqual([exact]);

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Hide variables for staging"]')!
          .click();
      });
      expect(container.textContent).not.toContain(exact);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Show variables for staging"]')!
          .click();
      });
      expect(container.textContent).not.toContain(exact);
      expect(reads).toBe(1);

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Reveal variable API_TOKEN"]')!
          .click();
      });
      expect(container.textContent).toContain(exact);
      await renderCard(1);
      expect(container.textContent).not.toContain(exact);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not render reveal or mutation controls without their explicit scopes", async () => {
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
            canWriteSet={false}
            canWriteSecrets={false}
            canReadSecrets={false}
            revealEpoch={0}
            onUpdate={async () => VARIABLE_SET}
            onDelete={async () => true}
            onReadVariable={async () => null}
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
      expect(container.querySelector('[aria-label="Reveal variable API_TOKEN"]')).toBeNull();
      expect(container.querySelector('[aria-label="Rotate variable API_TOKEN"]')).toBeNull();
      expect(container.querySelector('[aria-label="Delete variable API_TOKEN"]')).toBeNull();
      expect(container.querySelector('[aria-label="Edit variable set"]')).toBeNull();
      expect(container.querySelector('form[aria-label="Add variable to staging"]')).toBeNull();
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
