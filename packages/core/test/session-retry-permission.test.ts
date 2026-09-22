import { expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "../src/dependencies";
import { retryFailedSession } from "../src/domain/sessions";

test("failed-session retry requires control permission before any persistence access", async () => {
  const grant: AccessGrant = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "reader",
    permissions: ["sessions:read"],
  };
  // No persistence dependency is supplied: a missing permission must reject
  // before touching session history, command receipts, billing, or model state.
  await expect(
    retryFailedSession({} as ApiRouteDeps, grant, grant.workspaceId!, crypto.randomUUID(), {
      clientEventId: crypto.randomUUID(),
      failureEventId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 403 });
});
