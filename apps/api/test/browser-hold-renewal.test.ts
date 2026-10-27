import { expect, test } from "bun:test";
import { startBrowserHoldRenewalPump } from "../src/browser-hold-renewal";

test("a renewal pass that reaches its limit is reported, and an ordinary pass is not", async () => {
  const warnings: Array<{ message: string; attributes: unknown }> = [];
  const errors: string[] = [];
  const observability = {
    warn: (message: string, attributes: unknown) => warnings.push({ message, attributes }),
    error: (message: string) => errors.push(message),
  };
  const passes = [
    { listed: 3, held: 2, capped: false },
    { listed: 500, held: 480, capped: true },
  ];
  let ran = 0;
  const stop = startBrowserHoldRenewalPump(
    async () => passes[Math.min(ran++, passes.length - 1)]!,
    observability as never,
    5,
  );
  const passesRun = () => ran;
  for (let tries = 0; passesRun() < 2 && tries < 200; tries++) await Bun.sleep(5);
  await stop();
  expect(errors).toEqual([]);
  expect(warnings[0]).toEqual({
    message: "Browser hold renewal reached its per-pass limit",
    attributes: { listed: 500, held: 480 },
  });
  expect(warnings.every((warning) => warning.message === warnings[0]!.message)).toBe(true);
  expect(warnings.length).toBe(ran - 1);
});
