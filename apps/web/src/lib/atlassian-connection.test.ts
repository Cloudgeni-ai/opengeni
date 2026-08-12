import { describe, expect, test } from "bun:test";
import {
  ATLASSIAN_APP_DESCRIPTION,
  atlassianStatus,
  localConnectedAtlassianPreview,
  preferredAtlassianConnection,
} from "./atlassian-connection";

describe("Atlassian capabilities state", () => {
  test("states both live reading and optional synchronization", () => {
    expect(ATLASSIAN_APP_DESCRIPTION).toContain("Search Jira and Confluence live");
    expect(ATLASSIAN_APP_DESCRIPTION).toContain("optional knowledge synchronization");
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
