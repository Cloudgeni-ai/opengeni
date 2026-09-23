import { describe, expect, test } from "bun:test";
import { journeyOperation, journeyOutcome, journeyPage } from "./analytics-journey";

const workspace = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";

describe("content-free customer journey", () => {
  test("settings navigation retains the section without query content", () => {
    expect(
      journeyPage(
        `/workspaces/${workspace}/settings`,
        "?section=models&token=private&email=private",
      ),
    ).toEqual({ page: "settings", workspace_id: workspace, section: "models" });
    expect(journeyPage(`/workspaces/${workspace}/settings`, "?section=private")).toEqual({
      page: "settings",
      workspace_id: workspace,
    });
    expect(journeyPage("/reset-password/private", "?token=private")).toEqual({ page: "other" });
  });
  test("tracks starts and existing-session commands without inspecting content", () => {
    expect(journeyOperation(`/v1/workspaces/${workspace}/sessions`, "POST")?.operation).toBe(
      "session_create",
    );
    expect(
      journeyOperation(`/v1/workspaces/${workspace}/sessions/${session}/events`, "POST"),
    ).toEqual({
      operation: "session_command",
      properties: { workspace_id: workspace, session_id: session, method: "POST" },
    });
    expect(
      journeyOperation(
        `/v1/workspaces/${workspace}/sessions/${session}/composer-draft/submit`,
        "POST",
      )?.operation,
    ).toBe("session_command");
    expect(
      journeyOperation(`/v1/workspaces/${workspace}/sessions/${session}/events/stream`, "GET"),
    ).toBeNull();
    expect(journeyOperation("/v1/auth/sign-in/email", "POST")).toBeNull();
    expect(journeyOperation(`/v1/workspaces/${workspace}/secrets`, "POST")).toBeNull();
  });
  test("connection polling is not counted as a new attempt", () => {
    expect(
      journeyOperation(`/v1/workspaces/${workspace}/codex/connect/start`, "POST")?.operation,
    ).toBe("model_connection");
    expect(journeyOperation(`/v1/workspaces/${workspace}/codex/connect/poll`, "POST")).toBeNull();
  });
  test("distinguishes rejected admission from accepted requests", () => {
    expect(journeyOutcome(201)).toBe("accepted");
    expect(journeyOutcome(422)).toBe("invalid_request");
    expect(journeyOutcome(402)).toBe("credits_required");
    expect(journeyOutcome(503)).toBe("server_error");
  });
});
