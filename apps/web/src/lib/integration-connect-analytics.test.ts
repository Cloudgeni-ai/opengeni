import { describe, expect, test } from "bun:test";
import { PRODUCT_LIFECYCLE_FACT_ATTRIBUTES } from "@opengeni/contracts";

import {
  INTEGRATION_CONNECTION_CLASSES,
  MODEL_CONNECTION_CLASSES,
  beginIntegrationConnect,
  captureIntegrationConnectReturn,
  connectAttemptOutcome,
  integrationClassFromConnectProvider,
  integrationClassFromDomain,
  integrationConnectErrorOutcome,
  modelConnectionClass,
} from "./integration-connect-analytics";
import { parseIntegrationConnectReturn } from "./integration-connect-return";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function recorder(accept = true) {
  const events: Array<[string, Record<string, string>]> = [];
  return {
    events,
    capture: (name: string, properties: Record<string, string>) => {
      events.push([name, properties]);
      return accept;
    },
  };
}

describe("integration classes", () => {
  test("reuse the server lifecycle provider classes exactly", () => {
    expect([...INTEGRATION_CONNECTION_CLASSES]).toEqual([
      ...PRODUCT_LIFECYCLE_FACT_ATTRIBUTES["connection.created"],
    ]);
    expect([...MODEL_CONNECTION_CLASSES]).toEqual([
      ...PRODUCT_LIFECYCLE_FACT_ATTRIBUTES["model.connected"],
    ]);
  });

  test("map domains, MCP hosts, Connect providers and model providers", () => {
    expect(integrationClassFromDomain("mcp.linear.app")).toBe("linear");
    expect(integrationClassFromDomain("https://mcp.notion.com/mcp")).toBe("notion");
    expect(integrationClassFromDomain("gmailmcp.googleapis.com")).toBe("google");
    expect(integrationClassFromDomain("dev.azure.com")).toBe("azure_devops");
    expect(integrationClassFromDomain("evil-slack.com")).toBe("other");
    expect(integrationClassFromDomain(null)).toBe("other");
    expect(integrationClassFromConnectProvider("slack-bot")).toBe("slack");
    expect(integrationClassFromConnectProvider("github-personal")).toBe("github");
    expect(integrationClassFromConnectProvider("microsoft-outlook-mail")).toBe("microsoft");
    expect(integrationClassFromConnectProvider("google-drive-knowledge")).toBe("google");
    expect(integrationClassFromConnectProvider("openapi")).toBe("other");
    expect(modelConnectionClass("ai-gateway")).toBe("vercel_gateway");
    expect(modelConnectionClass("claude_subscription")).toBe("claude_subscription");
    expect(modelConnectionClass("unknown")).toBeNull();
  });

  test("map attempt states and errors to closed outcomes", () => {
    expect(connectAttemptOutcome({ state: "complete" })).toBe("connected");
    expect(connectAttemptOutcome({ state: "provider_wait" })).toBeNull();
    expect(connectAttemptOutcome({ state: "failed", error: { code: "provider_denied" } })).toBe(
      "denied",
    );
    expect(connectAttemptOutcome({ state: "failed", error: { code: "token_exchange" } })).toBe(
      "provider_error",
    );
    expect(connectAttemptOutcome({ state: "expired" })).toBe("abandoned");
    expect(integrationConnectErrorOutcome({ name: "ConnectPopupClosedError" })).toBe("cancelled");
    expect(integrationConnectErrorOutcome({ status: 422 })).toBe("provider_error");
    expect(integrationConnectErrorOutcome(new TypeError("Failed to fetch"))).toBe(
      "outcome_unknown",
    );
  });
});

describe("connect journey", () => {
  test("reports started and only the first outcome", () => {
    const { events, capture } = recorder();
    const journey = beginIntegrationConnect("slack", "oauth", { capture });
    journey.finish("connected");
    journey.finish("abandoned");
    expect(events).toEqual([
      ["integration_connect_started", { integration_class: "slack", method: "oauth" }],
      [
        "integration_connect_finished",
        { integration_class: "slack", method: "oauth", outcome: "connected" },
      ],
    ]);
  });

  test("without consent nothing is reported or stored", () => {
    const { events, capture } = recorder(false);
    const storage = new MemoryStorage();
    const journey = beginIntegrationConnect("github", "oauth", {
      capture,
      storage: storage as never,
    });
    journey.redirecting();
    expect(events.map(([name]) => name)).toEqual(["integration_connect_started"]);
    expect(storage.values.size).toBe(0);
  });

  test("an OAuth error return finishes the redirected journey as denied", () => {
    const storage = new MemoryStorage();
    const start = recorder();
    beginIntegrationConnect("notion", "oauth", {
      capture: start.capture,
      storage: storage as never,
      now: () => 1_000,
    }).redirecting();
    expect(start.events).toHaveLength(1);
    const returned = parseIntegrationConnectReturn(
      "?integration_oauth=error&stage=authorize&reason=access_denied&connect_item=x",
    );
    const finish = recorder();
    captureIntegrationConnectReturn({
      returned,
      capture: finish.capture,
      storage: storage as never,
      now: () => 2_000,
    });
    expect(finish.events).toEqual([
      [
        "integration_connect_finished",
        { integration_class: "notion", method: "oauth", outcome: "denied" },
      ],
    ]);
    expect(storage.values.size).toBe(0);
  });

  test("returning without an outcome counts as abandoned; a provider success maps its class", () => {
    const storage = new MemoryStorage();
    beginIntegrationConnect("linear", "oauth", {
      capture: recorder().capture,
      storage: storage as never,
      now: () => 0,
    }).redirecting();
    const back = recorder();
    captureIntegrationConnectReturn({
      returned: null,
      capture: back.capture,
      storage: storage as never,
      now: () => 1_000,
    });
    expect(back.events[0]![1].outcome).toBe("abandoned");

    const success = recorder();
    captureIntegrationConnectReturn({
      returned: parseIntegrationConnectReturn(
        "?integration_oauth=success&providerDomain=mcp.supabase.com&connectionId=abc",
      ),
      capture: success.capture,
      storage: new MemoryStorage() as never,
    });
    expect(success.events[0]![1]).toEqual({
      integration_class: "supabase",
      method: "oauth",
      outcome: "connected",
    });
    expect(parseIntegrationConnectReturn("?slack=error&reason=provider_denied")).toMatchObject({
      parameter: "slack",
      status: "error",
    });
    expect(parseIntegrationConnectReturn("?section=models")).toBeNull();
  });
});
