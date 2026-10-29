import { expect, test } from "bun:test";
import { capabilityMarkInitials } from "../src/components/session-capability-frame";
import { connectionCardSubtitle, showsMcpServerLabel } from "../src/in-chat-connect-model";

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

test("a reviewed service names its provider under its name; a hand-added server keeps its host", () => {
  const presentation = { providerName: "Google", introduction: "Let agents work with mail." };
  const base = {
    stale: false,
    authKind: "oauth2" as const,
    providerDomain: "gmailmcp.googleapis.com",
  };
  expect(connectionCardSubtitle({ ...base, source: "built_in", metadata: { presentation } })).toBe(
    "Google",
  );
  // No curated copy: nothing rather than a host name.
  expect(connectionCardSubtitle({ ...base, source: "library", metadata: {} })).toBe("");
  expect(connectionCardSubtitle({ ...base, source: "manual", metadata: { presentation } })).toBe(
    "gmailmcp.googleapis.com",
  );
  expect(
    connectionCardSubtitle({ ...base, source: "registry", metadata: {}, providerDomain: null }),
  ).toBe("");
  expect(connectionCardSubtitle(null)).toBe("");
});

test("a card's fallback mark uses each word's initial", () => {
  expect(capabilityMarkInitials("Google Calendar")).toBe("GC");
  expect(capabilityMarkInitials("  Gmail ")).toBe("GM");
  expect(capabilityMarkInitials("Google Drive for Work")).toBe("GD");
  expect(capabilityMarkInitials("")).toBe("");
});
