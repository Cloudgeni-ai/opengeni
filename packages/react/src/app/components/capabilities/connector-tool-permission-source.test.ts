import { describe, expect, test } from "bun:test";
import type { ConnectorToolPermissionEntry } from "@opengeni/contracts";
import { permissionSourceText } from "./connector-tool-permissions";

const entry = (
  extra: Partial<ConnectorToolPermissionEntry> = {},
): ConnectorToolPermissionEntry => ({
  name: "send_message",
  group: "write",
  permission: "ask",
  inherited: false,
  approvalRequired: true,
  ...extra,
});

describe("permission source", () => {
  test("names the setting that actually decides each tool", () => {
    expect(permissionSourceText(entry({ source: "recommended", inherited: true }))).toBe(
      "Recommended",
    );
    expect(permissionSourceText(entry({ source: "connector_default", inherited: true }))).toBe(
      "Uses default choice",
    );
    expect(permissionSourceText(entry({ source: "tool" }))).toBe("Your choice");
    expect(permissionSourceText(entry({ source: "action" }))).toBe("Your choice");
    expect(permissionSourceText(entry({ source: "tool", conditional: true }))).toBe(
      "Different choices for individual actions",
    );
    expect(permissionSourceText(entry({ source: "tool", resetReason: "operation_changed" }))).toBe(
      "Action changed · reset to Ask first",
    );
  });

  test("a tie between settings reads as a conflict that blocks, not as a choice", () => {
    expect(
      permissionSourceText(entry({ source: "conflict", permission: "block", inherited: false })),
    ).toBe("Two settings conflict, so it's blocked");
  });
});
