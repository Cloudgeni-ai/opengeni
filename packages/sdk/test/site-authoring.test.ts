import { expect, test } from "bun:test";
import {
  artifactEditInstructions,
  ARTIFACT_EDIT_TOOLS,
  ARTIFACT_EDIT_PERMISSIONS,
} from "../src/site-authoring";
test("shared Site authoring preserves narrow selection and host-owned completion navigation", () => {
  const input = { artifactId: "site", title: "Site", currentVersionId: "version" };
  expect(ARTIFACT_EDIT_TOOLS).toEqual(["artifacts_get_source", "artifacts_publish"]);
  expect(ARTIFACT_EDIT_PERMISSIONS).toEqual(["artifacts:read", "artifacts:publish"]);
  expect(artifactEditInstructions(input)).toContain(
    "/workspaces/<workspaceId>/artifacts/<artifactId>",
  );
  const exact = "https://HOST.example:443/sites/one?x=%2f#unchanged";
  const embedded = artifactEditInstructions({ ...input, completionHref: exact });
  expect(embedded).toContain(JSON.stringify(exact));
  expect(embedded).not.toContain("/workspaces/<workspaceId>");
  expect(embedded).toContain("current version version for optimistic concurrency");
  for (const completionHref of [
    "javascript:alert(1)",
    "//other.example",
    "https://user:password@host.example",
    "/site\nforged",
  ])
    expect(() => artifactEditInstructions({ ...input, completionHref })).toThrow();
});
