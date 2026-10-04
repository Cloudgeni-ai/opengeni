import { expect, test } from "bun:test";
import { acquireSharedTestDatabase, testSettings } from "@opengeni/testing";
import { createDb } from "../src/database";
import { buildSlackApiRateLimiter } from "../src/slack-api-rate-limits";

test("Slack quota is atomic across replicas/tokens and respects workspace/method/app and Retry-After", async () => {
  const fixture = await acquireSharedTestDatabase("slack-api-rate-limits");
  if (!fixture) throw new Error("Slack shared quota verification requires real PostgreSQL");
  const clients = [createDb(fixture.appUrl), createDb(fixture.appUrl)];
  const app = crypto.randomUUID();
  const settings = testSettings({ slackClientId: app, slackAccessMode: "limited" });
  const limiters = clients.map((client) => buildSlackApiRateLimiter(client.db, settings));
  try {
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, i) => limiters[i % 2]!("TEAM1", "conversations.history")),
    );
    expect(concurrent.filter((value) => value === 0)).toHaveLength(1);
    expect(concurrent.filter((value) => value >= 58)).toHaveLength(7);
    expect(await limiters[1]!("TEAM1", "conversations.replies")).toBe(0);
    expect(await limiters[1]!("TEAM2", "conversations.history")).toBe(0);
    const otherApp = buildSlackApiRateLimiter(clients[0]!.db, {
      ...settings,
      slackClientId: crypto.randomUUID(),
    });
    expect(await otherApp("TEAM1", "conversations.history")).toBe(0);
    await limiters[0]!("TEAM1", "chat.postMessage", 125);
    await limiters[1]!("TEAM1", "chat.postMessage", 3);
    expect(await limiters[1]!("TEAM1", "chat.postMessage")).toBeGreaterThanOrEqual(123);
    const full = buildSlackApiRateLimiter(clients[0]!.db, { ...settings, slackAccessMode: "full" });
    expect(await full("TEAM1", "chat.postMessage")).toBeGreaterThanOrEqual(123);
    expect(await full("TEAM3", "conversations.history")).toBe(0);
    expect(await full("TEAM3", "conversations.history")).toBe(0);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await fixture.release();
  }
}, 180_000);
