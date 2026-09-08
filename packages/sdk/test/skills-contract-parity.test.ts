import { expect, test } from "bun:test";
import type {
  SkillRecord as ContractRecord,
  SkillWriteReceipt as ContractReceipt,
} from "@opengeni/contracts";
import type { SkillRecord, SkillWriteReceipt } from "../src/skills";
import { OpenGeniClient } from "../src/client";

test("shared Skill SDK records and receipts match both directions", () => {
  const toSdk = (value: ContractRecord): SkillRecord => value;
  const toContract = (value: SkillRecord): ContractRecord => value;
  const receiptToSdk = (value: ContractReceipt): SkillWriteReceipt => value;
  const receiptToContract = (value: SkillWriteReceipt): ContractReceipt => value;
  expect(
    [toSdk, toContract, receiptToSdk, receiptToContract].every(
      (value) => typeof value === "function",
    ),
  ).toBe(true);
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
  expect(await client.listWorkspaceSkills("workspace", { cursor: "opaque+/=", limit: 25 })).toEqual(
    { skills: [], nextCursor: "next-page" },
  );
  const query = new URL(url).searchParams;
  expect(query.get("cursor")).toBe("opaque+/=");
  expect(query.get("limit")).toBe("25");
});
