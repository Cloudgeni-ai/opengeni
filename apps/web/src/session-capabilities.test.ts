import { describe, expect, test } from "bun:test";

import { builtInMcpCapability, sessionCapabilityGroupsFor } from "@/lib/session-capabilities";
import { firstPartySessionToolOptions } from "@/lib/session-tools";

describe("session capability product groups", () => {
  test("represents every exact first-party tool in one understandable group", () => {
    const groups = sessionCapabilityGroupsFor(firstPartySessionToolOptions);
    const groupedIds = groups.flatMap((group) => group.toolIds);

    expect(new Set(groupedIds)).toEqual(
      new Set(firstPartySessionToolOptions.map((option) => option.id)),
    );
    expect(groupedIds).toHaveLength(firstPartySessionToolOptions.length);
    expect(groups.some((group) => group.id === "other")).toBe(false);
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
