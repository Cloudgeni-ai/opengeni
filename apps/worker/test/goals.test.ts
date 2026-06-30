import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { ToolRef } from "@opengeni/contracts";
import { isSteerInterrupt, withCodexAppsTool } from "../src/activities/goals";

// The steer-vs-stop ruling: a `user.interrupt` tagged `reason: "steer"`
// (sent by OpenGeniClient.steerMessage) redirects the work instead of
// stopping it, so it must NOT pause an active goal. Everything else — the
// stop button, a plain interrupt, any other event type — is a stop.
describe("isSteerInterrupt", () => {
  test("recognizes a steer-tagged user.interrupt", () => {
    expect(isSteerInterrupt({ type: "user.interrupt", payload: { reason: "steer" } })).toBe(true);
  });

  test("a plain stop interrupt is not a steer", () => {
    expect(isSteerInterrupt({ type: "user.interrupt", payload: {} })).toBe(false);
    expect(isSteerInterrupt({ type: "user.interrupt", payload: { reason: "stop" } })).toBe(false);
    expect(isSteerInterrupt({ type: "user.interrupt", payload: null })).toBe(false);
  });

  test("non-interrupt triggers and missing triggers are never steers", () => {
    expect(isSteerInterrupt({ type: "user.message", payload: { reason: "steer" } })).toBe(false);
    expect(isSteerInterrupt(null)).toBe(false);
    expect(isSteerInterrupt(undefined)).toBe(false);
  });
});

describe("withCodexAppsTool", () => {
  const appsServer = { id: "codex_apps", name: "codex_apps", url: "https://chatgpt.com/backend-api/ps/mcp", cacheToolsList: false };

  test("appends the codex_apps ToolRef when the server is configured", () => {
    const settings = testSettings({ mcpServers: [appsServer] });
    const result = withCodexAppsTool(settings, []);
    expect(result).toContainEqual({ kind: "mcp", id: "codex_apps" });
  });

  test("is a no-op when the codex_apps server is not configured (every non-codex turn)", () => {
    const settings = testSettings({ mcpServers: [] });
    const tools: ToolRef[] = [{ kind: "mcp", id: "opengeni" }];
    const result = withCodexAppsTool(settings, tools);
    expect(result).toBe(tools); // same reference, untouched
  });

  test("is idempotent — does not double-add when already present", () => {
    const settings = testSettings({ mcpServers: [appsServer] });
    const once = withCodexAppsTool(settings, []);
    const twice = withCodexAppsTool(settings, once);
    expect(twice.filter((t) => t.kind === "mcp" && t.id === "codex_apps")).toHaveLength(1);
  });
});
