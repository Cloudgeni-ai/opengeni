import { expect, test } from "bun:test";
import { FirstPartyMcpToolName, FIRST_PARTY_REMOTE_MCP_TOOL_NAMES } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { resolveFirstPartyMcpToolPolicy } from "../src/index";

test("historical native Atlassian tools parse but cannot be advertised by a deployment policy", () => {
  const retired = ["atlassian_sources_list", "atlassian_search", "atlassian_get"] as const;
  for (const name of retired) {
    expect(FirstPartyMcpToolName.parse(name)).toBe(name);
    expect(FIRST_PARTY_REMOTE_MCP_TOOL_NAMES).not.toContain(name);
  }
  const allowed = [...retired, "session_get", "editable_artifact_export"] as const;
  expect(
    resolveFirstPartyMcpToolPolicy(
      testSettings({
        allowedFirstPartyMcpTools: [...allowed],
        defaultFirstPartyMcpTools: [...allowed],
      }),
    ),
  ).toEqual({
    allowed: ["session_get", "editable_artifact_export"],
    default: ["session_get", "editable_artifact_export"],
  });
});
