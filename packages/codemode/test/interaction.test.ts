import { describe, expect, test } from "bun:test";
import type { AttemptToolResult } from "@opengeni/contracts";
import {
  CodemodeClient,
  CodemodeToolExecutionError,
  createOpenGeniCodemode,
  type CodemodeCallOptions,
} from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const computerSessionId = "22222222-2222-4222-8222-222222222222";

describe("OpenGeni Codemode interaction facade", () => {
  test("uses the same atomic Browser paths with implicit selected-tab resolution", async () => {
    const fake = fakeClient((path, _args) => {
      if (path === "interaction.browser.open") {
        return result({ session: { id: browserSessionId }, targets: [] });
      }
      if (path === "interaction.browser.tabs") {
        return result({
          browserSessionId,
          controllerGeneration: "controller-1",
          targets: [{ id: "tab-1", selected: true }],
        });
      }
      if (path === "interaction.browser.act") {
        return result({ operationId: "operation-1", state: "completed" });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const openGeni = createOpenGeniCodemode(fake.client);
    const browser = await openGeni.browsers.open({ initialUrl: "https://example.test/" });
    const tab = await browser.tabs.selected();

    const receipt = await tab
      .getByRole("button", { name: "Save" })
      .click({ button: "left" }, { operationId: "33333333-3333-4333-8333-333333333333" });

    expect(browser.id).toBe(browserSessionId);
    expect(tab.id).toBe("tab-1");
    expect(receipt).toMatchObject({ state: "completed" });
    expect(fake.calls).toEqual([
      {
        path: "interaction.browser.open",
        args: { initialUrl: "https://example.test/" },
        options: {},
      },
      {
        path: "interaction.browser.tabs",
        args: { operation: "list", browserSessionId },
        options: {},
      },
      {
        path: "interaction.browser.act",
        args: {
          browserSessionId,
          targetId: "tab-1",
          action: {
            type: "click",
            locator: { kind: "role", role: "button", name: "Save" },
            button: "left",
          },
        },
        options: { operationId: "33333333-3333-4333-8333-333333333333" },
      },
    ]);
  });

  test("uses the focused Computer target and serializable native locator recipes", async () => {
    const fake = fakeClient((path, _args) => {
      if (path === "interaction.computer.open") {
        return result({ session: { id: computerSessionId }, targets: [] });
      }
      if (path === "interaction.computer.targets") {
        return result({
          computerSessionId,
          controllerGeneration: "controller-1",
          targets: [{ id: "window-1", focused: true }],
        });
      }
      if (path === "interaction.computer.act") {
        return result({ operationId: "operation-2", state: "completed" });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const computer = await createOpenGeniCodemode(fake.client).computers.open();
    const target = await computer.targets.focused();
    await target.getByIdentifier("total").setValue("42");

    expect(fake.calls.at(-1)).toEqual({
      path: "interaction.computer.act",
      args: {
        computerSessionId,
        targetId: "window-1",
        action: {
          type: "semantic",
          locator: { kind: "identifier", value: "total" },
          action: "set_value",
          value: "42",
        },
      },
      options: {},
    });
  });

  test("keeps identity creation on the caller-owned Codemode operation id", async () => {
    const fake = fakeClient((_path, args) =>
      result({
        operation: "create",
        result: { identity: { name: typeof args.name === "string" ? args.name : "" } },
      }),
    );
    const created = await createOpenGeniCodemode(fake.client).browsers.identities.create("Work", {
      operationId: "44444444-4444-4444-8444-444444444444",
    });

    expect(created).toMatchObject({ identity: { name: "Work" } });
    expect(fake.calls).toEqual([
      {
        path: "interaction.browser.identity",
        args: { operation: "create", name: "Work" },
        options: { operationId: "44444444-4444-4444-8444-444444444444" },
      },
    ]);
  });

  test("turns a typed atomic failure into a useful facade error", async () => {
    const fake = fakeClient(() => ({
      isError: true,
      content: [{ type: "text", text: "failed" }],
      structuredContent: {
        error: { code: "target_stale", message: "Observe again", retryable: true },
      },
    }));

    await expect(createOpenGeniCodemode(fake.client).browsers.open()).rejects.toMatchObject({
      name: "CodemodeToolExecutionError",
      code: "target_stale",
      retryable: true,
      message: "Observe again",
    } satisfies Partial<CodemodeToolExecutionError>);
  });
});

function result(
  structuredContent: NonNullable<AttemptToolResult["structuredContent"]>,
): AttemptToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function fakeClient(execute: (path: string, args: Record<string, unknown>) => AttemptToolResult): {
  client: CodemodeClient;
  calls: Array<{ path: string; args: Record<string, unknown>; options: CodemodeCallOptions }>;
} {
  const calls: Array<{
    path: string;
    args: Record<string, unknown>;
    options: CodemodeCallOptions;
  }> = [];
  const client = {
    callPath: async (
      path: readonly string[],
      args: Record<string, unknown>,
      options: CodemodeCallOptions,
    ) => {
      calls.push({ path: path.join("."), args, options });
      return execute(path.join("."), args);
    },
  } as CodemodeClient;
  return { client, calls };
}
