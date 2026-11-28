import { expect, test } from "bun:test";
import type {
  SkillRecord as ContractRecord,
  SkillWriteReceipt as ContractReceipt,
  SaveOrganizationSkillRequest as ContractOrganizationSave,
} from "@opengeni/contracts";
import type { SaveOrganizationSkillRequest, SkillRecord, SkillWriteReceipt } from "../src/skills";
import { OpenGeniClient } from "../src/client";

test("shared Skill SDK records and receipts match both directions", () => {
  const toSdk = (value: ContractRecord): SkillRecord => value;
  const toContract = (value: SkillRecord): ContractRecord => value;
  const receiptToSdk = (value: ContractReceipt): SkillWriteReceipt => value;
  const receiptToContract = (value: SkillWriteReceipt): ContractReceipt => value;
  const orgSaveToSdk = (value: ContractOrganizationSave): SaveOrganizationSkillRequest => value;
  const orgSaveToContract = (value: SaveOrganizationSkillRequest): ContractOrganizationSave =>
    value;
  expect(
    [toSdk, toContract, receiptToSdk, receiptToContract, orgSaveToSdk, orgSaveToContract].every(
      (value) => typeof value === "function",
    ),
  ).toBe(true);
});

test("organization Skill saves send initial reach without introducing a second write", async () => {
  const calls: unknown[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://example.test",
    fetch: (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ outcome: "applied" });
    }) as typeof fetch,
  });
  const request: SaveOrganizationSkillRequest = {
    operationId: "operation",
    skillId: "skill",
    stableKey: "procedure",
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    files: [{ path: "SKILL.md", content: "test" }],
    reason: "Publish",
    initialReach: { allowedWorkspaceIds: ["tenant"], allowPersonalWorkspaces: false },
  };
  expect(await client.saveOrganizationSkill("workspace", request)).toMatchObject({
    outcome: "applied",
  });
  expect(calls).toEqual([
    {
      url: "https://example.test/v1/workspaces/workspace/organization-skills/save",
      method: "POST",
      body: request,
    },
  ]);
});

test("Skill catalog pagination preserves the server cursor and sends bounded query options", async () => {
  let url = "";
  const client = new OpenGeniClient({
    baseUrl: "https://example.test",
    fetch: (async (input: RequestInfo | URL) => {
      url = String(input);
      return Response.json({ skills: [], nextCursor: "next-page" });
    }) as typeof fetch,
  });
  expect(
    await client.listWorkspaceSkills("workspace", {
      cursor: "opaque+/=",
      limit: 25,
      sessionId: "session",
    }),
  ).toEqual({ skills: [], nextCursor: "next-page" });
  const query = new URL(url).searchParams;
  expect(query.get("cursor")).toBe("opaque+/=");
  expect(query.get("limit")).toBe("25");
  expect(query.get("sessionId")).toBe("session");
});

test("Skill removal sends the exact concurrency and replay arguments", async () => {
  let captured: { url: string; method: string | undefined; body: unknown } | undefined;
  const client = new OpenGeniClient({
    baseUrl: "https://example.test",
    fetch: (async (input, init) => {
      captured = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
      return Response.json({ removed: true, outcome: "applied" });
    }) as typeof fetch,
  });
  const request = {
    operationId: "operation",
    expectedRevisionId: null,
    expectedScopeVersion: 3,
    reason: "Remove",
  };
  expect(await client.removeWorkspaceSkill("workspace", "skill/id", request)).toMatchObject({
    removed: true,
  });
  expect(captured).toEqual({
    url: "https://example.test/v1/workspaces/workspace/skills/content/skill%2Fid/remove",
    method: "POST",
    body: request,
  });
});
