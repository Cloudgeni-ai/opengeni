// `relayDialBaseFromSettings` — the canonical relay dial-BASE URL handed to the
// agent PRODUCER. The agent appends only its routing query and assumes the base
// already carries the relay's `/stream` route; a path-less base 400s the dial and
// makes the terminal/desktop streams unreachable (dossier §V5/§V6). These lock the
// normalization: pathless → `/stream`, explicit path honored, non-default port kept,
// unconfigured → "" (graceful no-relay degrade), and producer/consumer agreement.
import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { relayConfigFromSettings, relayDialBaseFromSettings } from "../src/sandbox/routing";

const base = (selfhostedRelayUrl: string | undefined) =>
  relayDialBaseFromSettings(testSettings({ selfhostedRelayUrl }));

describe("relayDialBaseFromSettings — agent producer dial base", () => {
  test("path-less wss URL gains the relay's /stream route", () => {
    // The exact deployed-preview shape that 400'd the producer dial.
    expect(base("wss://relay.preview.app.opengeni.ai")).toBe(
      "wss://relay.preview.app.opengeni.ai/stream",
    );
    expect(base("wss://relay.example")).toBe("wss://relay.example/stream");
  });

  test("an explicit path is honored (idempotent — no double /stream)", () => {
    expect(base("wss://relay.example/stream")).toBe("wss://relay.example/stream");
    expect(base("wss://relay.example/custom")).toBe("wss://relay.example/custom");
  });

  test("a non-default port is preserved; default 443/80 is elided", () => {
    expect(base("wss://relay.example:8443")).toBe("wss://relay.example:8443/stream");
    expect(base("wss://relay.example:443")).toBe("wss://relay.example/stream");
    expect(base("ws://relay.example:80")).toBe("ws://relay.example/stream");
    expect(base("ws://relay.example:8080")).toBe("ws://relay.example:8080/stream");
  });

  test("an unconfigured relay maps to '' (graceful no-relay degrade)", () => {
    // The agent must report no-relay, NOT dial a synthetic host.
    expect(base(undefined)).toBe("");
    expect(base("")).toBe("");
    expect(base("   ")).toBe("");
  });

  test("the producer base agrees with the CONSUMER config (same /stream route)", () => {
    const settings = testSettings({ selfhostedRelayUrl: "wss://relay.preview.app.opengeni.ai" });
    const consumer = relayConfigFromSettings(settings);
    const producer = relayDialBaseFromSettings(settings);
    // Producer dial base ends with exactly the path the consumer dials.
    expect(producer.endsWith(consumer.path)).toBe(true);
    expect(consumer.path).toBe("/stream");
  });
});
