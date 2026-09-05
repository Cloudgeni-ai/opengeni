import { expect, test } from "bun:test";
import type { OpenGeniClient } from "@opengeni/sdk";
import { createWorkspaceInstructionSave } from "./workspace-instruction-save";

test("an uncertain save belongs to its exact client, workspace, text, and baseline", () => {
  const client = {} as OpenGeniClient;
  const head = { revisionId: "initial", activationVersion: 1 };
  const save = createWorkspaceInstructionSave(client, "workspace", "text", head);
  expect(save.matches(client, "workspace", "text", { ...head })).toBe(true);
  expect(save.matches({} as OpenGeniClient, "workspace", "text", head)).toBe(false);
  expect(save.matches(client, "another", "text", head)).toBe(false);
  expect(save.matches(client, "workspace", "edited", head)).toBe(false);
  expect(save.matches(client, "workspace", "text", { ...head, activationVersion: 2 })).toBe(false);
  expect(save.matches(client, "workspace", "text", { ...head, revisionId: "new" })).toBe(false);
});
