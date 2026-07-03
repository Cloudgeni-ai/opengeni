import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../../src/timeline";
import { serializeTimeline } from "./serialize";

const fixturesDir = join(import.meta.dir, "fixtures");
const snapshotsDir = join(import.meta.dir, "snapshots");

mkdirSync(snapshotsDir, { recursive: true });

const fixtureFiles = readdirSync(fixturesDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

for (const file of fixtureFiles) {
  const name = basename(file, ".json");
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as SessionEvent[];
  const items = buildTimeline(fixture);
  const groups = groupTimeline(items);
  await Bun.write(join(snapshotsDir, `${name}.json`), `${JSON.stringify(serializeTimeline(items, groups), null, 2)}\n`);
}

console.log(`Regenerated ${fixtureFiles.length} timeline golden snapshot(s).`);
