import { expect, test } from "bun:test";
import { SkillLifecycleRefusedError } from "@opengeni/db";
import {
  skillRefusalMessage,
  skillWriteAuthorizer,
} from "../src/activities/agent-turn/skill-tools";

test("Skill writes refuse an agent started from a Site page, after the live-attempt check", async () => {
  const calls: string[] = [];
  const authorize = async () => {
    calls.push("attempt");
  };
  const clamped = skillWriteAuthorizer(authorize, async () => {
    calls.push("clamp");
    return true;
  });
  const refused = await clamped().then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(SkillLifecycleRefusedError);
  expect(skillRefusalMessage(refused as SkillLifecycleRefusedError)).toBe(
    "Nothing was saved: An agent started from a Site page cannot create or change Skills.",
  );
  expect(calls).toEqual(["attempt", "clamp"]);

  // Any other agent writes as before; a dead attempt fails before the clamp is read.
  await expect(skillWriteAuthorizer(authorize, async () => false)()).resolves.toBeUndefined();
  calls.length = 0;
  const dead = skillWriteAuthorizer(
    async () => {
      throw new Error("Skill access requires the exact live attempt");
    },
    async () => {
      calls.push("clamp");
      return false;
    },
  );
  await expect(dead()).rejects.toThrow("exact live attempt");
  expect(calls).toEqual([]);
});
