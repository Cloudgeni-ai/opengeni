import { expect, test } from "bun:test";
import { McpServerConnectionRef as ContractRef } from "@opengeni/contracts";
import { McpServerConnectionRefSchema as ConfigRef } from "@opengeni/config";
import type { McpServerConnectionRef } from "../src/types";

test("SDK and deployment configuration expose the same fixed and accepted-turn host reference", () => {
  const selections: McpServerConnectionRef[] = [
    {
      authoritySource: "host",
      providerDomain: "tools.example",
      subjectScope: "subject",
      hostBinding: { selection: "accepted_turn" },
    },
    {
      authoritySource: "host",
      providerDomain: "tools.example",
      connectionId: "account",
      hostBinding: { bindingId: crypto.randomUUID(), generation: 1 },
    },
  ];
  for (const selection of selections) {
    const parsed: McpServerConnectionRef = ContractRef.parse(selection);
    expect(parsed).toEqual(selection);
    expect(ConfigRef.parse(selection)).toEqual(parsed);
  }
});
