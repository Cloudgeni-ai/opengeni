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
  expect(save.matches(client, "workspace", "text", head, true)).toBe(false);
});

function recordingClient() {
  const calls: Array<[string, unknown]> = [];
  const client = {
    createWorkspaceInstructionPolicyDraft: async (_workspaceId: string, request: unknown) => {
      calls.push(["draft", request]);
      return { id: "draft", content: (request as { content: string }).content };
    },
    activateWorkspaceInstructionPolicyRevision: async (
      _workspaceId: string,
      _revisionId: string,
      request: unknown,
    ) => {
      calls.push(["activate", request]);
      return { head: { revisionId: "draft", activationVersion: 2 } };
    },
    updateWorkspace: async (_workspaceId: string, request: unknown) => {
      calls.push(["workspace", request]);
      return {};
    },
  } as unknown as OpenGeniClient;
  return { client, calls };
}

test("saving empty text clears the instructions and any earlier-settings override", async () => {
  const head = { revisionId: "initial", activationVersion: 1 };
  const { client, calls } = recordingClient();
  const saved = await createWorkspaceInstructionSave(client, "workspace", "  \n", head, true).run();
  expect(saved.content).toBe("");
  expect(calls.map(([name]) => name)).toEqual(["workspace", "draft", "activate"]);
  expect(calls[0]?.[1]).toEqual({ agentInstructions: null });
  expect(calls[1]?.[1]).toMatchObject({ content: "", supersedesRevisionId: "initial" });
  expect(calls[2]?.[1]).toMatchObject({
    expectedCurrentRevisionId: "initial",
    expectedActivationVersion: 1,
    reason: "Cleared by a workspace admin from Knowledge",
  });
});

test("saving text never touches the earlier-settings override", async () => {
  const { client, calls } = recordingClient();
  await createWorkspaceInstructionSave(client, "workspace", "Be brief.", null, true).run();
  expect(calls.map(([name]) => name)).toEqual(["draft", "activate"]);
  expect(calls[0]?.[1]).toMatchObject({ content: "Be brief." });
});
