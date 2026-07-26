import { describe, expect, test } from "bun:test";

import {
  runNewSessionRouteSubmission,
  type CreatedSessionRouteAuthority,
} from "./sessions-index-submission";

describe("sessions-index post-create authority", () => {
  test("a sibling-tab draft conflict retries navigation without creating a second session", async () => {
    let authority: CreatedSessionRouteAuthority | null = null;
    let creates = 0;
    let conflictResolved = false;
    let settlementAttempts = 0;
    const navigations: string[] = [];

    const settleDraft = async () => {
      settlementAttempts += 1;
      return conflictResolved;
    };
    const create = async () => {
      creates += 1;
      return {
        sessionId: "created-once",
        // The sibling tab won the revision-zero draft reinsert. The route must
        // leave the conflict visible while retaining this created-session ID.
        settleDraft,
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
    expect(settlementAttempts).toBe(1);
    expect(navigations).toEqual([]);
    expect((authority as CreatedSessionRouteAuthority | null)?.sessionId).toBe("created-once");
    expect((authority as CreatedSessionRouteAuthority | null)?.settleDraft).toBe(settleDraft);

    // After the user resolves the draft conflict, the next route submission
    // retries settlement and cannot create another session/initial turn.
    conflictResolved = true;
    expect(
      await runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).toBe(true);
    expect(creates).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(navigations).toEqual(["created-once"]);
    expect(authority).toBeNull();
  });

  test("a transient non-conflict preservation failure retains the newer draft and same session", async () => {
    let authority: CreatedSessionRouteAuthority | null = null;
    let creates = 0;
    let settlementAttempts = 0;
    const navigations: string[] = [];
    const newerDraft = { text: "edited during create", fileId: "newer-ready-file" };
    const durableDrafts: (typeof newerDraft)[] = [];

    const settleDraft = async () => {
      settlementAttempts += 1;
      if (settlementAttempts === 1) return false;
      durableDrafts.push({ ...newerDraft });
      return true;
    };
    const create = async () => {
      creates += 1;
      return { sessionId: "created-before-transient-failure", settleDraft };
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
    expect(durableDrafts).toEqual([]);
    expect(navigations).toEqual([]);
    expect((authority as CreatedSessionRouteAuthority | null)?.sessionId).toBe(
      "created-before-transient-failure",
    );
    expect((authority as CreatedSessionRouteAuthority | null)?.settleDraft).toBe(settleDraft);

    expect(
      await runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).toBe(true);
    expect(creates).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(durableDrafts).toEqual([newerDraft]);
    expect(navigations).toEqual(["created-before-transient-failure"]);
    expect(authority).toBeNull();
  });

  test("a failed navigation retains exact create authority for a safe retry", async () => {
    let authority: CreatedSessionRouteAuthority | null = null;
    let creates = 0;
    let settlements = 0;
    let navigationAttempts = 0;
    const create = async () => {
      creates += 1;
      return {
        sessionId: "created-before-navigation-failure",
        settleDraft: async () => {
          settlements += 1;
          return true;
        },
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
      settleDraft: null,
    });

    expect(
      await runNewSessionRouteSubmission({ authority, create, navigate, onAuthorityChange }),
    ).toBe(true);
    expect(creates).toBe(1);
    expect(settlements).toBe(1);
    expect(navigationAttempts).toBe(2);
    expect(authority).toBeNull();
  });
});
