import { describe, expect, test } from "bun:test";
import { SelfhostedControlError } from "@opengeni/runtime/sandbox";
import { HTTPException } from "hono/http-exception";
import {
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
  test("names the swap tool, the exact target and the way back", () => {
    const message = wrongInteractionPlacementMessage("7f099792-650d-4356-96c5-e0df3aab4752");
    expect(message).toStartWith(
      "The requested Connected Machine is not this session's current placement.",
    );
    expect(message).toContain(
      'if sandbox_swap is available, call it with target "7f099792-650d-4356-96c5-e0df3aab4752"',
    );
    expect(message).toContain('swap back (target "session") when done');
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
