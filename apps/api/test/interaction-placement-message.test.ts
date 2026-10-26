import { describe, expect, test } from "bun:test";
import { ActiveBackendUnresolvableError, SelfhostedControlError } from "@opengeni/runtime/sandbox";
import { HTTPException } from "hono/http-exception";
import {
  activeRouteUnavailableError,
  wrongInteractionPlacementMessage,
  wrongPlacementInsteadOfOffline,
} from "../src/routes/interaction-placement-message";

const requested = "321d7b48-f4bb-434b-899b-2b3fe90d58b5";
const offline = () =>
  new SelfhostedControlError({
    message: "Connected Machine has no live runner connection",
    code: 0,
    reason: "agent_offline",
    retryable: false,
    agentOffline: true,
  });

describe("wrong interaction placement message", () => {
  test("names the swap tool and the exact target, and never asks to swap back", () => {
    const message = wrongInteractionPlacementMessage("7f099792-650d-4356-96c5-e0df3aab4752");
    expect(message).toStartWith(
      "The requested Connected Machine is not the machine this session is working on",
    );
    expect(message).toContain(
      'call sandbox_swap with target "7f099792-650d-4356-96c5-e0df3aab4752" if it is available, then retry',
    );
    expect(message).toContain("staying on that machine afterwards is fine");
    expect(message).not.toContain("swap back");
    expect(message).not.toContain('"session"');
  });
});

describe("wrong placement instead of offline", () => {
  test("an offline current machine elsewhere becomes the wrong-placement answer", async () => {
    const answered = await wrongPlacementInsteadOfOffline(
      offline(),
      requested,
      async () => "7f099792-650d-4356-96c5-e0df3aab4752",
    );
    expect(answered).toBeInstanceOf(HTTPException);
    expect((answered as HTTPException).status).toBe(422);
    expect((answered as HTTPException).message).toBe(wrongInteractionPlacementMessage(requested));
  });

  test("a session with no current machine also gets the wrong-placement answer", async () => {
    const answered = await wrongPlacementInsteadOfOffline(offline(), requested, async () => null);
    expect((answered as HTTPException).status).toBe(422);
  });

  // The chat's current machine can be unresolvable before any request reaches
  // it: it has no live connection, or is no longer usable from this chat.
  // That was a 500; it is the same wrong-placement answer.
  for (const code of ["offline_enrollment", "stale_pointer"] as const) {
    test(`a current machine that cannot be resolved (${code}) is the wrong-placement answer`, async () => {
      const answered = await wrongPlacementInsteadOfOffline(
        new ActiveBackendUnresolvableError(
          code,
          "selfhosted sandbox has no live runner connection",
        ),
        requested,
        async () => "7f099792-650d-4356-96c5-e0df3aab4752",
      );
      expect((answered as HTTPException).status).toBe(422);
      expect((answered as HTTPException).message).toBe(wrongInteractionPlacementMessage(requested));
    });
  }

  test("the requested machine itself being offline stays an offline failure", async () => {
    const error = offline();
    expect(await wrongPlacementInsteadOfOffline(error, requested, async () => requested)).toBe(
      error,
    );
  });

  test("other failures and an unreadable placement pass through unchanged", async () => {
    const other = new Error("boom");
    let read = false;
    expect(
      await wrongPlacementInsteadOfOffline(other, requested, async () => {
        read = true;
        return null;
      }),
    ).toBe(other);
    expect(read).toBe(false);
    const error = offline();
    expect(
      await wrongPlacementInsteadOfOffline(error, requested, async () => {
        throw new Error("db unavailable");
      }),
    ).toBe(error);
  });
});

describe("current machine unavailable", () => {
  test("an unresolvable current machine is a 409 that says so, not a 500", () => {
    const offlineMachine = activeRouteUnavailableError(
      new ActiveBackendUnresolvableError("offline_enrollment", "sandbox x has no live runner"),
    );
    expect(offlineMachine?.status).toBe(409);
    expect(offlineMachine?.message).toBe(
      "The Connected Machine this session is working on is not connected.",
    );
    const gone = activeRouteUnavailableError(
      new HTTPException(500, {
        cause: new ActiveBackendUnresolvableError("stale_pointer", "sandbox x not found"),
      }),
    );
    expect(gone?.status).toBe(409);
    expect(gone?.message).toBe(
      "The Connected Machine this session is working on is no longer available to it.",
    );
    const other = activeRouteUnavailableError(
      new ActiveBackendUnresolvableError("workspace_root_unavailable", "reconnect it"),
    );
    expect(other?.message).toBe("reconnect it");
    expect(activeRouteUnavailableError(new Error("boom"))).toBeNull();
  });
});
