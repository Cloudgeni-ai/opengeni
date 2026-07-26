import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../src/timeline";
import { serializeTimeline } from "./golden/serialize";
import type { SerializedTimeline } from "./golden/serialize";

const CONTRACT_CHANGED =
  "the event-grammar contract changed; if intentional, regenerate snapshots (bun packages/react/test/golden/regenerate.ts) and include the diff in your PR for review";

const fixturesDir = join(import.meta.dir, "golden", "fixtures");
const snapshotsDir = join(import.meta.dir, "golden", "snapshots");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function project(events: SessionEvent[]) {
  const items = buildTimeline(events);
  return serializeTimeline(items, groupTimeline(items));
}

describe("golden event grammar", () => {
  const fixtureFiles = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  for (const file of fixtureFiles) {
    const name = basename(file, ".json");
    test(name, () => {
      const actual = project(readJson<SessionEvent[]>(join(fixturesDir, file)));
      const expected = readJson<SerializedTimeline>(join(snapshotsDir, `${name}.json`));
      try {
        expect(actual).toEqual(expected);
      } catch (error) {
        throw new Error(
          `${CONTRACT_CHANGED}\nFixture: ${file}\n${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    });
  }

  test("coalesced compact fixture projects identically to its raw delta fixture", () => {
    const raw = project(readJson<SessionEvent[]>(join(fixturesDir, "05-coalesced-raw.json")));
    const compact = project(
      readJson<SessionEvent[]>(join(fixturesDir, "05-coalesced-compact.json")),
    );
    try {
      expect(compact).toEqual(raw);
    } catch (error) {
      throw new Error(
        `${CONTRACT_CHANGED}\nFixture: 05-coalesced-compact.json\n${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
});
