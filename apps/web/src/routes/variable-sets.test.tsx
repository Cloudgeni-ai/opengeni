import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  normalizeVariableNameInput,
  variableNameError,
  sessionUsesVariableSet,
  VariableSetCard,
} from "./variable-sets";
import { ManagedAuthPanel } from "@/components/managed-auth-panel";
import type { Session, WorkspaceVariableSet } from "@/types";

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

describe("Variable Sets credential-autofill boundaries", () => {
  test("normalizes friendly labels into portable environment names", () => {
    expect(normalizeVariableNameInput("test-key")).toBe("TEST_KEY");
    expect(normalizeVariableNameInput("  service token  ")).toBe("SERVICE_TOKEN");
    expect(normalizeVariableNameInput("api.key/value")).toBe("API_KEY_VALUE");
  });

  test("explains names reserved by the sandbox before submission", () => {
    expect(variableNameError("HOME")).toBe("HOME is reserved. Choose another name.");
    expect(variableNameError("OPENGENI_TOKEN")).toBe(
      "Names beginning with OPENGENI_ are reserved. Choose another name.",
    );
    expect(variableNameError("MY_APP_TOKEN")).toBeNull();
  });

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

  test("blocks deletion when the variable set is a lower-precedence session attachment", async () => {
    const session = {
      id: "session-1",
      initialMessage: "Uses staging credentials",
      variableSetIds: [VARIABLE_SET.id, "variable-set-higher"],
      variableSetId: "variable-set-higher",
    } as unknown as Session;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <VariableSetCard
            workspaceId="workspace-1"
            variableSet={VARIABLE_SET}
            attachedSessions={[session].filter((candidate) =>
              sessionUsesVariableSet(candidate, VARIABLE_SET.id),
            )}
            attachedTasks={[]}
            attachmentsUnknown={false}
            mutating={false}
            canWriteSet={true}
            canWriteSecrets={true}
            canReadSecrets={true}
            revealEpoch={0}
            onUpdate={async () => VARIABLE_SET}
            onDelete={async () => true}
            onReadVariable={async () => null}
            onSetVariable={async () => ({})}
            onDeleteVariable={async () => true}
          />,
        );
      });

      const deleteButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete variable set"]',
      );
      expect(deleteButton).not.toBeNull();
      expect(deleteButton!.disabled).toBeTrue();
      expect(deleteButton!.title).toBe("Detach it from sessions and tasks first");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

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

      const manageButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Manage variables for staging"]',
      );
      const editButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit details for staging"]',
      );
      expect(manageButton?.textContent?.trim()).toBe("Manage variables");
      expect(editButton?.textContent?.trim()).toBe("Edit details");

      await act(async () => {
        editButton!.click();
      });
      expect(container.querySelector('[aria-label="Variable set name"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Variable set description"]')).not.toBeNull();
      expect(container.querySelector('form[aria-label="Add variable to staging"]')).toBeNull();

      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Cancel")!
          .click();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Manage variables for staging"]')!
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

  test("shows and submits the normalized environment name instead of a backend 422", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const writes: Array<{ name: string; value: string }> = [];

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
            onReadVariable={async () => null}
            onSetVariable={async (name, value) => {
              writes.push({ name, value });
              return {};
            }}
            onDeleteVariable={async () => true}
          />,
        );
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Manage variables for staging"]')!
          .click();
      });

      const name = container.querySelector<HTMLInputElement>('[aria-label="New variable name"]')!;
      const value = container.querySelector<HTMLInputElement>('[aria-label="New variable value"]')!;
      await setInputValue(name, "1test-key");
      await setInputValue(value, "secret-value");
      const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Add variable",
      )!;
      expect(name.value).toBe("1test-key");
      expect(container.textContent).toContain("Start the name with a letter");
      expect(submit.disabled).toBeTrue();

      await setInputValue(name, "test-key");

      expect(name.value).toBe("test-key");
      expect(container.textContent).toContain("Saved as TEST_KEY");
      expect(submit.disabled).toBeFalse();
      await act(async () => {
        submit.click();
        await Promise.resolve();
      });
      expect(writes).toEqual([{ name: "TEST_KEY", value: "secret-value" }]);
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
          .querySelector<HTMLButtonElement>('button[aria-label="Manage variables for staging"]')!
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
          .querySelector<HTMLButtonElement>('button[aria-label="Manage variables for staging"]')!
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
          .querySelector<HTMLButtonElement>('button[aria-label="Manage variables for staging"]')!
          .click();
      });
      expect(container.querySelector('[aria-label="Reveal variable API_TOKEN"]')).toBeNull();
      expect(container.querySelector('[aria-label="Rotate variable API_TOKEN"]')).toBeNull();
      expect(container.querySelector('[aria-label="Delete variable API_TOKEN"]')).toBeNull();
      expect(container.querySelector('[aria-label="Edit details for staging"]')).toBeNull();
      expect(container.querySelector('form[aria-label="Add variable to staging"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  // The Variable Set forms above must look like nothing a password manager
  // should save; the managed sign-in form is the exact opposite boundary and
  // must keep the credential tokens that let one save and refill the account.
  // Assert the rendered attributes rather than the component source: this form
  // has already moved once (out of `context.tsx` into `ManagedAuthPanel`), and
  // a source-text assertion silently stops protecting anything when that
  // happens.
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
