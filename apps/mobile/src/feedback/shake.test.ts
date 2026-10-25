import { expect, test } from "bun:test";
import { createShakeDetector, SHAKE_COOLDOWN_MS } from "./shake";

const jolt = { x: 2.5, y: 0.4, z: 0.3 };
const still = { x: 0, y: 0, z: 1 };

test("three strong jolts close together are one shake", () => {
  let shakes = 0;
  const detect = createShakeDetector(() => shakes++);
  detect(jolt, 0);
  detect(still, 100);
  detect(jolt, 300);
  detect(jolt, 600);
  expect(shakes).toBe(1);
});

test("a single bump or jolts spread out are not a shake", () => {
  let shakes = 0;
  const detect = createShakeDetector(() => shakes++);
  detect(jolt, 0);
  detect(jolt, 1000);
  detect(jolt, 2000);
  expect(shakes).toBe(0);
});

test("shaking on during the cooldown does not open a second report", () => {
  let shakes = 0;
  const detect = createShakeDetector(() => shakes++);
  for (const at of [0, 200, 400, 600, 800, 1000]) detect(jolt, at);
  expect(shakes).toBe(1);
  for (const at of [0, 200, 400]) detect(jolt, 400 + SHAKE_COOLDOWN_MS + at);
  expect(shakes).toBe(2);
});
