import { expect, test } from "bun:test";
import { composeRuntimeSkills } from "../src/runtime-skills";

test("project guidance is discoverable through the bundled skill index", () => {
  const composition = composeRuntimeSkills([], {
    projects: true,
    editableArtifacts: false,
    videoGeneration: false,
  });
  expect(composition.nativeToolNames).toEqual(["opengeni-projects"]);
  const index = composition.lazySource.getIndex({ extraPathGrants: [] }, ".agents");
  expect(index).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "opengeni-projects" })]),
  );
  expect(composeRuntimeSkills([]).nativeToolNames).not.toContain("opengeni-projects");
});
