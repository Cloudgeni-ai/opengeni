import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const functionStart = source.indexOf("export async function deleteWorkspaceIfQuiescent(");
const functionEnd = source.indexOf("\nexport async function ", functionStart + 1);
const deletionSource = source.slice(functionStart, functionEnd);

test("preauthorizes before the lifecycle lock and reauthorizes after it", () => {
  expect(functionStart).toBeGreaterThanOrEqual(0);
  const preflightAuthorization = deletionSource.indexOf(
    "await authorizeOrganizationWorkspaceDeletion(",
  );
  const lifecycleLock = deletionSource.indexOf("await lockBackgroundCommandWorkspaceLifecycle(");
  const authoritativeAuthorization = deletionSource.indexOf(
    "await authorizeOrganizationWorkspaceDeletion(",
    preflightAuthorization + 1,
  );
  expect(preflightAuthorization).toBeGreaterThan(-1);
  expect(lifecycleLock).toBeGreaterThan(preflightAuthorization);
  expect(authoritativeAuthorization).toBeGreaterThan(lifecycleLock);
});
