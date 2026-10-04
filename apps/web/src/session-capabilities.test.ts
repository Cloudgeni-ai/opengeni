import { describe, expect, test } from "bun:test";

import { builtInMcpCapability, sessionCapabilityGroupsFor } from "@/lib/session-capabilities";
import { firstPartySessionToolOptions } from "@/lib/session-tools";

describe("session capability product groups", () => {
  test("represents every current first-party tool once and omits retired native Atlassian tools", () => {
    const retiredNativeToolIds = new Set([
      "atlassian_sources_list",
      "atlassian_search",
      "atlassian_get",
    ]);
    const expectedToolIds = firstPartySessionToolOptions
      .map((option) => option.id)
      .filter((id) => !retiredNativeToolIds.has(id));
    const groups = sessionCapabilityGroupsFor(firstPartySessionToolOptions);
    const groupedIds = groups.flatMap((group) => group.toolIds);

    expect(new Set(groupedIds)).toEqual(new Set(expectedToolIds));
    expect(groupedIds).toHaveLength(expectedToolIds.length);
    for (const id of retiredNativeToolIds) expect(groupedIds).not.toContain(id);
    expect(groups.some((group) => group.id === "atlassian")).toBe(false);
    expect(groups.some((group) => group.id === "other")).toBe(false);
    expect(groups.find((group) => group.id === "workspace")?.toolIds).toContain(
      "custom_mcp_setup_request",
    );
    expect(groups.find((group) => group.toolIds.includes("command_wait"))?.toolIds).toContain(
      "command_read",
    );
  });

  test("keeps native files and knowledge out of connected apps", () => {
    expect(builtInMcpCapability({ id: "files" })?.name).toBe("Files");
    expect(builtInMcpCapability({ id: "docs" })?.name).toBe("Documents");
    expect(
      sessionCapabilityGroupsFor(firstPartySessionToolOptions).find(
        (group) => group.id === "knowledge",
      )?.name,
    ).toBe("Memory & learning");
    expect(builtInMcpCapability({ id: "gmail" })).toBeNull();
  });
});
