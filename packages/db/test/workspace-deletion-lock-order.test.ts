import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const functionStart = source.indexOf("export async function deleteWorkspaceIfQuiescent(");
const functionEnd = source.indexOf("\nexport async function ", functionStart + 1);
const deletionSource = source.slice(functionStart, functionEnd);

test("takes the deletion lifecycle lock before organization authorization", () => {
  expect(functionStart).toBeGreaterThanOrEqual(0);
  expect(deletionSource.indexOf("await lockBackgroundCommandWorkspaceLifecycle(")).toBeGreaterThan(
    -1,
  );
  expect(
    deletionSource.indexOf("authorize_organization_shared_workspace_administration("),
  ).toBeGreaterThan(-1);
  expect(deletionSource.indexOf("await lockBackgroundCommandWorkspaceLifecycle(")).toBeLessThan(
    deletionSource.indexOf("authorize_organization_shared_workspace_administration("),
  );
});
