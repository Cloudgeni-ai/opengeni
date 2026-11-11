import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

describe("session event cursor foundation", () => {
  test("places the narrow cursor in the canonical writer lock prefix", async () => {
    const source = await readFile(join(repo, "packages/db/src/session-control.ts"), "utf8");
    const helper = source.slice(
      source.indexOf("export async function lockSessionEventWriteRows"),
      source.indexOf("export async function registerSessionTurnAttemptClaim"),
    );
    const sessionLock = helper.indexOf(".from(schema.sessions)");
    const cursorLock = helper.indexOf(".from(schema.sessionEventCursors)");
    const turnLock = helper.indexOf(".from(schema.sessionTurns)");
    const attemptLock = helper.indexOf(".from(schema.sessionTurnAttempts)");

    expect(sessionLock).toBeGreaterThanOrEqual(0);
    expect(cursorLock).toBeGreaterThan(sessionLock);
    expect(turnLock).toBeGreaterThan(cursorLock);
    expect(attemptLock).toBeGreaterThan(turnLock);
    expect(helper).toContain("cursor.lastSequence < session.lastSequence");
    expect(helper).toContain("lastSequence: cursor.lastSequence");
    expect(helper).toContain("Session event cursor is behind session projection");
  });
});
