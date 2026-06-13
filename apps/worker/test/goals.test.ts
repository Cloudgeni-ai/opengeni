import { describe, expect, test } from "bun:test";
import { isSteerInterrupt } from "../src/activities/goals";

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
