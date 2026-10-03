import { describe, expect, test } from "bun:test";
import {
  ATLASSIAN_APP_DESCRIPTION,
  atlassianStatus,
  localConnectedAtlassianPreview,
  preferredAtlassianConnection,
} from "./atlassian-connection";

describe("Atlassian capabilities state", () => {
  test("states retirement and points to hosted agent tools", () => {
    expect(ATLASSIAN_APP_DESCRIPTION).toContain("knowledge sync is retired");
    expect(ATLASSIAN_APP_DESCRIPTION).toContain("Atlassian agent tools");
  });

  test("projects the local connected QA fixture", () => {
    const connection = localConnectedAtlassianPreview(
      "?previewAtlassian=connected",
      "workspace",
      true,
    );
    expect(connection).not.toBeNull();
    expect(atlassianStatus(connection, true)).toBe("connected");
    expect(preferredAtlassianConnection([connection!])?.id).toBe(connection?.id);
  });
});
