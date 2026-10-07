import { describe, expect, test } from "bun:test";
import { SessionRealtimeConflictError } from "@opengeni/db";
import { sessionRealtimeHttpError } from "../src/routes/sessions";

describe("session realtime conflict responses", () => {
  test("say what a person can do instead of naming internal ownership state", () => {
    const active = sessionRealtimeHttpError(
      new SessionRealtimeConflictError(
        "REALTIME_ACTIVE",
        "Session already has an active realtime owner",
      ),
    );
    expect(active.status).toBe(409);
    expect(active.message).toBe(
      "Voice is already on for this session in another tab or window. End it there, or try again in a minute.",
    );
    expect(
      sessionRealtimeHttpError(
        new SessionRealtimeConflictError(
          "CONTROL_NOT_ACTIVE",
          "Session control must be active before realtime starts",
        ),
      ).message,
    ).toBe("Resume this session to start voice.");
  });

  test("keeps protocol conflicts and missing modes unchanged", () => {
    const missing = sessionRealtimeHttpError(
      new SessionRealtimeConflictError("REALTIME_NOT_FOUND", "Realtime mode not found"),
    );
    expect(missing.status).toBe(404);
    expect(missing.message).toBe("Realtime mode not found");
    expect(
      sessionRealtimeHttpError(
        new SessionRealtimeConflictError(
          "REALTIME_VERSION_CHANGED",
          "Realtime lease version changed",
        ),
      ).message,
    ).toBe("Realtime lease version changed");
  });
});
