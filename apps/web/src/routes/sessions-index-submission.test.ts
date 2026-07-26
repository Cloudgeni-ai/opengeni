import { describe, expect, test } from "bun:test";

import {
  runNewSessionRouteSubmission,
  type CreatedSessionRouteAuthority,
} from "./sessions-index-submission";

describe("sessions-index post-create authority", () => {
  test("a sibling-tab draft conflict retries navigation without creating a second session", async () => {
    let authority: CreatedSessionRouteAuthority | null = null;
    let creates = 0;
    const navigations: string[] = [];

    const create = async () => {
      creates += 1;
      return {
        sessionId: "created-once",
        // The sibling tab won the revision-zero draft reinsert. The route must
        // leave the conflict visible while retaining this created-session ID.
        settleDraft: async () => false,
      };
    };
    const onAuthorityChange = (next: CreatedSessionRouteAuthority | null) => {
      authority = next;
    };
    const navigate = async (sessionId: string) => {
      navigations.push(sessionId);
    };

    expect(
      await runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).toBe(false);
    expect(creates).toBe(1);
    expect(navigations).toEqual([]);
    expect(authority as CreatedSessionRouteAuthority | null).toEqual({
      sessionId: "created-once",
    });

    // After the user resolves the draft conflict, the next route submission is
    // navigation recovery only. It cannot create another session/initial turn.
    expect(
      await runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).toBe(true);
    expect(creates).toBe(1);
    expect(navigations).toEqual(["created-once"]);
    expect(authority).toBeNull();
  });

  test("a failed navigation retains exact create authority for a safe retry", async () => {
    let authority: CreatedSessionRouteAuthority | null = null;
    let creates = 0;
    let navigationAttempts = 0;
    const create = async () => {
      creates += 1;
      return {
        sessionId: "created-before-navigation-failure",
        settleDraft: async () => true,
      };
    };
    const onAuthorityChange = (next: CreatedSessionRouteAuthority | null) => {
      authority = next;
    };
    const navigate = async () => {
      navigationAttempts += 1;
      if (navigationAttempts === 1) throw new Error("router unavailable");
    };

    await expect(
      runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).rejects.toThrow("router unavailable");
    expect(authority as CreatedSessionRouteAuthority | null).toEqual({
      sessionId: "created-before-navigation-failure",
    });

    expect(
      await runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).toBe(true);
    expect(creates).toBe(1);
    expect(navigationAttempts).toBe(2);
    expect(authority).toBeNull();
  });
});
