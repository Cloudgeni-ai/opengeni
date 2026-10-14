import { describe, expect, mock, test } from "bun:test";
import {
  lockLiveNativeOriginalOriginTx,
  type ModalNativeLiveOriginScope,
} from "../src/modal-native-live-origin";
import type { Database } from "../src/database";

function scope(): ModalNativeLiveOriginScope {
  return {
    version: 2,
    declarationId: crypto.randomUUID(),
    planId: crypto.randomUUID(),
    creatorId: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    triggerEventId: crypto.randomUUID(),
    sandboxGroupId: crypto.randomUUID(),
    routeKind: "home",
    routeTargetId: null,
    routeEpoch: 0,
  };
}
describe("native LIVE-origin correlation parsing (never authentication)", () => {
  test("root handle is not an in-transaction admission", async () => {
    await expect(lockLiveNativeOriginalOriginTx({} as Database, scope())).rejects.toThrow(
      "existing transaction",
    );
  });
  test("extra fields, accessor values, noncanonical UUID and number coercions never query DB", async () => {
    const execute = mock(() => {
      throw new Error("unexpected SQL");
    });
    const tx = { rollback() {}, execute } as unknown as Database;
    const valid = scope();
    const accessor = { ...valid };
    const getter = mock(() => valid.accountId);
    Object.defineProperty(accessor, "accountId", { get: getter });
    for (const input of [
      { ...valid, initiatingHumanSubjectId: "user:attacker" },
      accessor,
      { ...valid, accountId: valid.accountId.toUpperCase() },
      { ...valid, creatorId: valid.attemptId },
      { ...valid, creatorId: valid.planId },
      { ...valid, executionGeneration: "1" },
      { ...valid, executionGeneration: 0 },
      { ...valid, routeEpoch: -1 },
      { ...valid, routeEpoch: 0.5 },
      { ...valid, routeTargetId: crypto.randomUUID() },
      { ...valid, routeKind: "active" },
    ])
      expect(await lockLiveNativeOriginalOriginTx(tx, input as ModalNativeLiveOriginScope)).toEqual(
        { kind: "unsupported", reason: "invalid_scope" },
      );
    expect(execute).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});
