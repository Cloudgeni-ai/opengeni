import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BrowserActionRequest } from "@opengeni/contracts";
import {
  NEWER_BROWSER_ACTION_OPTIONS,
  olderBrowserControllerMessage,
} from "../src/sandbox/browser-controller-compatibility";

type Shapes = Record<string, Record<string, string>>;

const surface = JSON.parse(
  readFileSync(new URL("../../../scripts/public-api/surface.gen.json", import.meta.url), "utf8"),
) as { schemas: Record<string, { shape: Record<string, string> }> };
const baseline = JSON.parse(
  readFileSync(
    new URL("./fixtures/browser-controller-action-contract.json", import.meta.url),
    "utf8",
  ),
) as { agentVersion: string; roots: string[]; schemas: Shapes };

/** The flattened shapes of every public schema an action command carries. */
function currentShapes(): Shapes {
  const shapes: Shapes = {};
  const pending = [...baseline.roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (shapes[name] || !surface.schemas[name]) continue;
    shapes[name] = surface.schemas[name].shape;
    for (const value of Object.values(shapes[name])) {
      for (const match of value.matchAll(/ref\((\w+)\)/g)) pending.push(match[1]!);
    }
  }
  return shapes;
}

function sentAction(action: unknown) {
  return BrowserActionRequest.parse({
    operationId: crypto.randomUUID(),
    targetId: "target-1",
    action,
  }).action;
}

describe("browser actions an older controller rejects", () => {
  test("every option added since the baseline agent is named for older controllers", () => {
    const listed = new Set(NEWER_BROWSER_ACTION_OPTIONS.flatMap((option) => option.surfaceKeys));
    const unlisted: string[] = [];
    for (const [schema, shape] of Object.entries(currentShapes())) {
      for (const [path, value] of Object.entries(shape)) {
        const key = `${schema} ${path}`;
        if (baseline.schemas[schema]?.[path] !== value && !listed.has(key)) unlisted.push(key);
      }
    }
    // A browser action option or value that agents up to the baseline did not
    // accept: add an entry to NEWER_BROWSER_ACTION_OPTIONS naming it, so an
    // older connected-machine controller's refusal says what to drop.
    expect(unlisted).toEqual([]);
  });

  test("listed surface keys exist in the current contract", () => {
    const shapes = currentShapes();
    for (const key of NEWER_BROWSER_ACTION_OPTIONS.flatMap((option) => option.surfaceKeys)) {
      const [schema, path] = key.split(" ") as [string, string];
      expect(shapes[schema]?.[path]).toBeDefined();
    }
  });

  test("names exact on a text locator inside a batch and its alternative", () => {
    const action = sentAction({
      type: "batch",
      actions: [
        { type: "fill", locator: { kind: "ref", ref: "e1" }, value: "x" },
        { type: "click", locator: { kind: "text", text: "Save", exact: true } },
      ],
    });
    expect(olderBrowserControllerMessage(action, true)).toBe(
      "This browser's controller runs in an older Opengeni agent that does not accept " +
        '"exact" on a text or label locator. Nothing ran. Retry without "exact", or target ' +
        "the element by its ref. Updating the agent adds support.",
    );
    expect(
      olderBrowserControllerMessage(
        sentAction({ type: "click", locator: { kind: "label", text: "Email", exact: false } }),
        false,
      ),
    ).toBe(
      "This browser's controller image is older than this server and does not accept " +
        '"exact" on a text or label locator. Nothing ran. Retry without "exact", or target ' +
        "the element by its ref. Updating the controller image adds support.",
    );
  });

  test("an older role locator exact or no newer option gets the general refusal", () => {
    for (const action of [
      { type: "click", locator: { kind: "role", role: "button", name: "Save", exact: true } },
      { type: "click", locator: { kind: "text", text: "Save" } },
    ]) {
      expect(olderBrowserControllerMessage(sentAction(action), true)).toBe(
        "This browser's controller runs in an older Opengeni agent that does not accept this " +
          "action. Nothing ran. Retry with fewer options, or target elements by ref. Updating " +
          "the agent adds support.",
      );
    }
  });
});
