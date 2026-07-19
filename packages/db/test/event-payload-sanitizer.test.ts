import { describe, expect, test } from "bun:test";
import { SESSION_EVENT_PAYLOAD_MAX_BYTES, sessionEventJsonBytes } from "@opengeni/contracts";
import {
  sanitizeEventPayload,
  sanitizeEventString,
  sanitizeModelPayload,
} from "../src/event-payload-sanitizer";

const NUL = String.fromCharCode(0);
const REPLACEMENT = "�";
const LONE_HIGH = "\uD800";
const LONE_LOW = "\uDFFF";
const VALID_PAIR = "\u{1F600}"; // grinning face emoji, a valid surrogate pair

/**
 * A value Postgres `jsonb` accepts must contain no NUL bytes and no lone UTF-16
 * surrogates. Mirror that check so the tests fail the same way the INSERT would.
 */
function isJsonbSafe(value: string): boolean {
  if (value.includes(NUL)) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false; // lone low surrogate
    }
  }
  return true;
}

describe("sanitizeEventString", () => {
  test("strips NUL bytes", () => {
    expect(sanitizeEventString(`a${NUL}b${NUL}`)).toBe("ab");
  });

  test("replaces a lone high surrogate with the replacement char", () => {
    expect(sanitizeEventString(`x${LONE_HIGH}y`)).toBe(`x${REPLACEMENT}y`);
  });

  test("replaces a lone low surrogate with the replacement char", () => {
    expect(sanitizeEventString(`x${LONE_LOW}y`)).toBe(`x${REPLACEMENT}y`);
  });

  test("preserves a valid surrogate pair (emoji)", () => {
    expect(sanitizeEventString(`hi ${VALID_PAIR}!`)).toBe(`hi ${VALID_PAIR}!`);
  });

  test("returns the same reference when already clean (no allocation)", () => {
    const clean = "ordinary log line with pässwörd ✓ and emoji \u{1F600}";
    expect(sanitizeEventString(clean)).toBe(clean);
  });
});

describe("sanitizeEventPayload (deep walk)", () => {
  test("sanitizes nested strings in objects and arrays", () => {
    const payload = {
      type: "agent.toolCall.output",
      output: `chrome log${NUL}line\nrandom ${LONE_HIGH} bytes`,
      nested: {
        list: [`ok`, `binary${NUL}cat`, { deep: `${LONE_LOW}tail` }],
      },
      count: 42,
      flag: true,
    };

    const cleaned = sanitizeEventPayload(payload);

    expect(cleaned.output).toBe(`chrome logline\nrandom ${REPLACEMENT} bytes`);
    expect(cleaned.nested.list[1] as string).toBe("binarycat");
    expect((cleaned.nested.list[2] as { deep: string }).deep).toBe(`${REPLACEMENT}tail`);
    expect(cleaned.count).toBe(42);
    expect(cleaned.flag).toBe(true);
  });

  test("sanitizes object keys carrying NUL / surrogates", () => {
    const payload = { [`k${NUL}ey`]: "v", [`${LONE_HIGH}`]: "w" };
    const cleaned = sanitizeEventPayload(payload) as Record<string, string>;
    expect(Object.keys(cleaned)).toEqual(["key", REPLACEMENT]);
  });

  test("FAILURE-SENSITIVE: a payload that would crash the INSERT round-trips as valid jsonb", () => {
    // Reproduces the turn-killer: exec output with a NUL byte AND a lone
    // surrogate inside an agent.toolCall.output / sandbox.command.output event.
    const rawExecOutput = `crashpad ${NUL} dump ${LONE_HIGH} ${VALID_PAIR} end`;
    const eventPayload = {
      kind: "sandbox.command.output",
      command: `cat ${NUL} /bin/ls`,
      output: rawExecOutput,
      stream: "stdout",
    };

    // Before sanitization the raw string values are NOT jsonb-safe (the pg
    // driver ships the actual UTF-8 bytes, so a NUL byte / lone surrogate in the
    // value -- not a JSON-escaped form -- is what makes the INSERT throw).
    expect(isJsonbSafe(eventPayload.output)).toBe(false);
    expect(isJsonbSafe(eventPayload.command)).toBe(false);

    const cleaned = sanitizeEventPayload(eventPayload);

    // After sanitization every string value is jsonb-safe.
    expect(isJsonbSafe(cleaned.output)).toBe(true);
    expect(isJsonbSafe(cleaned.command)).toBe(true);

    // ...and the cleaned payload survives a JSON serialize/parse round-trip.
    const reparsed = JSON.parse(JSON.stringify(cleaned)) as typeof cleaned;
    expect(reparsed.output).toBe(`crashpad  dump ${REPLACEMENT} ${VALID_PAIR} end`);
    expect(reparsed.command).toBe("cat  /bin/ls");
    expect(reparsed.kind).toBe("sandbox.command.output");
    expect(reparsed.stream).toBe("stdout");
  });

  test("redacts session MCP credential header values to names", () => {
    const cleaned = sanitizeEventPayload({
      mcpServers: [
        {
          id: "crm",
          url: "https://crm.example/mcp",
          headers: { Authorization: "Bearer create-secret" },
        },
      ],
      mcpCredentialUpdates: [
        {
          id: "crm",
          headers: { Authorization: "Bearer rotated-secret", "X-Session": "turn-2" },
        },
      ],
    }) as unknown as {
      mcpServers: Array<{ id: string; url: string; headerNames: string[] }>;
      mcpCredentialUpdates: Array<{ id: string; headerNames: string[] }>;
    };

    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain("create-secret");
    expect(serialized).not.toContain("rotated-secret");
    expect(cleaned.mcpServers[0]).toEqual({
      id: "crm",
      url: "https://crm.example/mcp",
      headerNames: ["Authorization"],
    });
    expect(cleaned.mcpCredentialUpdates[0]).toEqual({
      id: "crm",
      headerNames: ["Authorization", "X-Session"],
    });
  });

  test("redacts secret-shaped fields from tool auth-needed payloads", () => {
    const cleaned = sanitizeEventPayload({
      serverId: "cap-linear",
      toolName: "linear__create_issue",
      providerDomain: "linear.app",
      reason: "missing_connection",
      scopes: ["issues:write"],
      authorizationUrl: "https://linear.app/oauth/authorize?client_id=public-client",
      access_token: "raw-access-token",
      refreshToken: "raw-refresh-token",
      encryptedPkceVerifier: "v1:secret-verifier",
      headers: { authorization: "Bearer raw-token" },
      nested: { credentialEncrypted: "v1:secret-bundle" },
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain("raw-access-token");
    expect(serialized).not.toContain("raw-refresh-token");
    expect(serialized).not.toContain("secret-verifier");
    expect(serialized).not.toContain("secret-bundle");
    expect(cleaned.authorizationUrl).toBe(
      "https://linear.app/oauth/authorize?client_id=public-client",
    );
    expect(cleaned.access_token).toBe("[redacted]");
    expect(cleaned.refreshToken).toBe("[redacted]");
    expect(cleaned.encryptedPkceVerifier).toBe("[redacted]");
    expect(cleaned.headers).toBe("[redacted]");
    expect((cleaned.nested as Record<string, unknown>).credentialEncrypted).toBe("[redacted]");
  });

  test("bounds cyclic and multi-megabyte payloads before deep sanitation", () => {
    const payload: Record<string, unknown> = {
      id: "cycle-output",
      token: "must-not-survive",
      output: "界😀".repeat(500_000),
    };
    payload.self = payload;

    const cleaned = sanitizeEventPayload(payload) as Record<string, unknown>;
    expect(sessionEventJsonBytes(cleaned)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
    expect(JSON.stringify(cleaned)).not.toContain("must-not-survive");
    expect(JSON.stringify(cleaned)).toContain("depth boundary");
    expect(cleaned.truncation).toMatchObject({
      truncated: true,
      fullEvidence: { available: false, reason: "not_retained" },
    });
  });
});

describe("session_history_items jsonb safety (durable SDK item)", () => {
  test("FAILURE-SENSITIVE: a function_call_result item with binary tool output round-trips as valid jsonb", () => {
    // The agent-SDK durable history `item` jsonb carries raw tool/command
    // output. A NUL byte or lone surrogate in that output 400s the INSERT and
    // silently drops resumption history. Reproduce a realistic SDK item.
    const rawToolOutput = `build log ${NUL} chunk ${LONE_HIGH} ${VALID_PAIR} done`;
    const historyItem = {
      type: "function_call_result",
      call_id: "call_abc123",
      name: "run_command",
      output: {
        type: "text",
        text: rawToolOutput,
      },
    };

    // The raw nested value is NOT jsonb-safe — this is what makes the INSERT throw.
    expect(isJsonbSafe(historyItem.output.text)).toBe(false);

    const cleaned = sanitizeModelPayload(historyItem);

    // After sanitization the nested value is jsonb-safe.
    expect(isJsonbSafe(cleaned.output.text)).toBe(true);

    // Structure is preserved beyond the NUL / lone-surrogate byte classes.
    expect(cleaned.type).toBe("function_call_result");
    expect(cleaned.call_id).toBe("call_abc123");
    expect(cleaned.name).toBe("run_command");
    expect(cleaned.output.type).toBe("text");

    // NUL dropped, lone surrogate -> replacement char, valid emoji preserved.
    expect(cleaned.output.text).toBe(`build log  chunk ${REPLACEMENT} ${VALID_PAIR} done`);

    // ...and the cleaned item survives a JSON serialize/parse round-trip.
    const reparsed = JSON.parse(JSON.stringify(cleaned)) as typeof cleaned;
    expect(reparsed.output.text).toBe(`build log  chunk ${REPLACEMENT} ${VALID_PAIR} done`);
    expect(reparsed.type).toBe("function_call_result");
  });

  test("repairs invalid text without redacting model-visible tool arguments", () => {
    const item = {
      type: "function_call",
      callId: "call_secret_arg",
      name: "configure_provider",
      arguments: {
        token: `actual${NUL}value`,
        headers: { authorization: "Bearer model-visible" },
      },
    };
    expect(sanitizeModelPayload(item)).toEqual({
      ...item,
      arguments: {
        token: "actualvalue",
        headers: { authorization: "Bearer model-visible" },
      },
    });
    expect(sanitizeEventPayload(item)).toMatchObject({
      arguments: { token: "[redacted]", headers: "[redacted]" },
    });
  });

  test("makes cyclic and over-depth model payloads explicit and JSON-safe", () => {
    const cyclic: Record<string, unknown> = { type: "function_call_result" };
    cyclic.output = cyclic;
    const cycleCleaned = sanitizeModelPayload(cyclic) as Record<string, unknown>;
    expect(JSON.stringify(cycleCleaned)).toContain("omitted cyclic model payload");

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 80; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    const depthCleaned = sanitizeModelPayload(deep);
    expect(JSON.stringify(depthCleaned)).toContain("database-safety depth");
  });
});
