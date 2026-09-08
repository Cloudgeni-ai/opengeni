import { expect, test } from "bun:test";
import type { ConnectAttempt, ConnectProvider, ConnectAdvance } from "../src/types";
import { ConnectAttempt as AttemptSchema } from "../../contracts/src/connect";
import type * as Contract from "../../contracts/src/connect";

// Browser values must remain compatible with the canonical server wire types.
type Assert<T extends true> = T;
type Compatible<A, B> = [A] extends [B] ? true : false;
type Parity = [
  Assert<Compatible<ConnectAttempt, Contract.ConnectAttempt>>,
  Assert<Compatible<ConnectProvider, Contract.ConnectProvider>>,
  Assert<Compatible<ConnectAdvance, Contract.ConnectAdvance>>,
];
const parity: Parity = [true, true, true];
test("Connect wire mirrors remain compatible and completion is not credential-only", () => {
  expect(parity).toEqual([true, true, true]);
  expect(
    AttemptSchema.safeParse({
      id: "attempt",
      workspaceId: "workspace",
      providerId: "provider",
      ownership: "personal",
      revision: 1,
      state: "complete",
      credentialsCommitted: true,
      integrationInstalled: false,
      completionRequirement: "integration",
      nextAction: { type: "none" },
      expiresAt: "2027-01-01T00:00:00Z",
    }).success,
  ).toBe(false);
});
