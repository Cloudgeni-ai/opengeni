import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { codexAccountsLackingTurnModel } from "../src/activities/agent-turn/codex-capacity";

const settings = testSettings({ codexSubscriptionEnabled: true });
const db = {} as never;

test("the turn learns which accounts cannot serve its model", async () => {
  const lacking = await codexAccountsLackingTurnModel(
    db,
    settings,
    "ws",
    "gpt-6-sol",
    async (_db, _settings, _ws, model) => new Set(model === "gpt-6-sol" ? ["free"] : []),
  );
  expect(lacking).toEqual(new Set(["free"]));
});

test("a slow or failing lookup never delays or fails the turn", async () => {
  const started = Date.now();
  const slow = await codexAccountsLackingTurnModel(
    db,
    settings,
    "ws",
    "gpt-6-sol",
    () => new Promise(() => undefined),
    20,
  );
  expect(slow).toEqual(new Set());
  expect(Date.now() - started).toBeLessThan(1_000);
  const failing = await codexAccountsLackingTurnModel(db, settings, "ws", "gpt-6-sol", async () => {
    throw new Error("provider down");
  });
  expect(failing).toEqual(new Set());
  expect(
    await codexAccountsLackingTurnModel(db, settings, "ws", null, async () => new Set(["x"])),
  ).toEqual(new Set());
});
