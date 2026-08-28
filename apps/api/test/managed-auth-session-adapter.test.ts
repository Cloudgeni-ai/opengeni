import { describe, expect, test } from "bun:test";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";

const selected = {
  slotId: "7438e162-ded0-45fe-94f1-f4548ca532f8",
  authSessionId: "auth-session-1",
  authUserId: "auth-user-1",
  token: "selected-token",
  email: "actor@example.test",
  name: "Actor",
  emailVerified: true,
};

describe("Better Auth session-set adapter", () => {
  test("rejects expired or expiry-less selected sessions without sliding provider expiry", async () => {
    let candidate: unknown;
    const auth = {
      $context: Promise.resolve({
        internalAdapter: {
          findSession: async (token: string) => {
            expect(token).toBe(selected.token);
            return candidate;
          },
        },
      }),
    };
    const adapter = createBetterAuthSessionAdapter(auth as never, {} as never);
    const shape = (expiresAt?: Date | string) => ({
      session: {
        id: selected.authSessionId,
        userId: selected.authUserId,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
      user: {
        id: selected.authUserId,
        email: selected.email,
        name: selected.name,
        emailVerified: true,
      },
    });

    candidate = shape(new Date(Date.now() - 1_000));
    expect(await adapter.resolveSelectedSession(selected)).toBeNull();
    candidate = shape();
    expect(await adapter.resolveSelectedSession(selected)).toBeNull();
    candidate = shape(new Date(Date.now() + 60_000).toISOString());
    expect(await adapter.resolveSelectedSession(selected)).toEqual(candidate);
  });
});
