import { describe, expect, test } from "bun:test";

import { filterWorkspaceConfigGroups, WORKSPACE_CONFIG_GROUPS } from "./workspace-nav-data";

function labels(sites: boolean, advanced = false): string[] {
  return filterWorkspaceConfigGroups(WORKSPACE_CONFIG_GROUPS, true, sites, advanced).flatMap(
    (group) => group.items.map((item) => item.label),
  );
}

describe("Sites and Advanced Deployments workspace navigation", () => {
  test("keeps both independent surfaces absent by default", () => {
    expect(labels(false)).not.toContain("Sites");
    expect(labels(false)).not.toContain("Advanced deployments");
    expect(
      filterWorkspaceConfigGroups(WORKSPACE_CONFIG_GROUPS, true).flatMap((group) =>
        group.items.map((item) => item.label),
      ),
    ).not.toContain("Sites");
  });

  test("shows each surface only under its own feature gate", () => {
    expect(labels(true)).toContain("Sites");
    expect(labels(true)).not.toContain("Advanced deployments");
    expect(labels(false, true)).not.toContain("Sites");
    expect(labels(false, true)).toContain("Advanced deployments");
  });
});
