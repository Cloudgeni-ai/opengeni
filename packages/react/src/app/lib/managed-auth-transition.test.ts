import { describe, expect, test } from "bun:test";

import { signOutWithAuthoritativeReconciliation } from "./managed-auth-transition";

describe("managed sign-out reconciliation", () => {
  test("committed sign-out with a lost response remains gated until the authoritative null", async () => {
    let releaseRead!: () => void;
    const readStarted = Promise.withResolvers<void>();
    const readRelease = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let settled = false;
    const result = signOutWithAuthoritativeReconciliation({
      signOut: async () => {
        throw new Error("response lost");
      },
      readSession: async () => {
        readStarted.resolve();
        await readRelease;
        return null;
      },
    }).finally(() => {
      settled = true;
    });

    await readStarted.promise;
    expect(settled).toBe(false);
    releaseRead();
    const reconciled = await result;
    expect(reconciled.status).toBe("reconciled_failure");
    expect(reconciled.session).toBeNull();
  });

  test("definitive failure restores only the session returned by the authoritative read", async () => {
    const authoritative = { userId: "current-cookie-user" };
    const result = await signOutWithAuthoritativeReconciliation({
      signOut: async () => {
        throw new Error("sign-out rejected");
      },
      readSession: async () => authoritative,
    });

    expect(result).toMatchObject({
      status: "reconciled_failure",
      session: authoritative,
    });
  });

  test("successful sign-out does not perform a redundant session read", async () => {
    let reads = 0;
    const result = await signOutWithAuthoritativeReconciliation({
      signOut: async () => {},
      readSession: async () => {
        reads += 1;
        return { userId: "unexpected" };
      },
    });

    expect(result).toEqual({ status: "signed_out", session: null });
    expect(reads).toBe(0);
  });
});
