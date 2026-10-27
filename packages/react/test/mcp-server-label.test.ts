import { expect, test } from "bun:test";
import { showsMcpServerLabel } from "../src/in-chat-connect-model";

const reviewedProbe = { mcpProbe: { status: "real" } };

test("reviewed catalog integrations carry no MCP server label", () => {
  for (const source of ["built_in", "library", "configured"] as const)
    expect(showsMcpServerLabel({ source, stale: false, authKind: "oauth2", metadata: {} })).toBe(
      false,
    );
  expect(
    showsMcpServerLabel({
      source: "registry",
      stale: false,
      authKind: "oauth2",
      metadata: reviewedProbe,
    }),
  ).toBe(false);
});

test("hand-added or unreviewed servers keep the label; unknown shows none", () => {
  expect(
    showsMcpServerLabel({ source: "manual", stale: false, authKind: null, metadata: {} }),
  ).toBe(true);
  expect(
    showsMcpServerLabel({ source: "public_registry", stale: false, authKind: null, metadata: {} }),
  ).toBe(true);
  expect(
    showsMcpServerLabel({ source: "registry", stale: false, authKind: "oauth2", metadata: {} }),
  ).toBe(true);
  expect(showsMcpServerLabel(undefined)).toBe(false);
});
