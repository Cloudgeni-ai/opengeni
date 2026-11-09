import { expect, test } from "bun:test";
import { reducedWorkspaceSaveNote } from "../src/activities/run-input";

test("the reduced-save note names the save time and the left-out folders", () => {
  expect(
    reducedWorkspaceSaveNote({
      capturedAt: "2026-11-04T08:15:00.000Z",
      omittedPaths: ["node_modules", "web/.next"],
    }),
  ).toBe(
    "Workspace note: this workspace was last saved at 2026-11-04T08:15:00.000Z without these folders, which can be rebuilt: node_modules, web/.next. If they are missing, reinstall dependencies or rebuild before relying on them.",
  );
});

test("the reduced-save note lists at most 20 folders", () => {
  const omittedPaths = Array.from({ length: 23 }, (_, index) => `p${index}/node_modules`);
  const note = reducedWorkspaceSaveNote({ capturedAt: "2026-11-04T08:15:00.000Z", omittedPaths });
  expect(note).toContain("p19/node_modules and 3 more.");
  expect(note).not.toContain("p20/node_modules");
});
