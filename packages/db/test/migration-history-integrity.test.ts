import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const governedHashes = [
  [
    "0066_session_interruption_attempt_lookup.sql",
    "0403a927f7e80e1ec8ca6e0d0a698d02f6602a6a499da4174bc278e696374028",
  ],
  [
    "0070_session_event_type_sequence_lookup.sql",
    "5938e8f2c02b15bd403346e58b2c5d13168e2f016ee9577f3991cf73b8555e4d",
  ],
  [
    "0071_session_event_monitoring_tail.sql",
    "b26beba717aab13ea2a91ec5f4e349461b448c86821f2ad597fdee04fffc81ed",
  ],
  [
    "0072_sessions_workspace_created_id_idx.sql",
    "fd34a7d68ab68d397234bfea98998d3de7b709474f26cba5d7817596dba3a7a5",
  ],
  [
    "0073_sessions_workspace_updated_id_idx.sql",
    "2902316ad06aae7e42c3bb43bcedebcd16bddfe21370b3d7062738debb502a9f",
  ],
  [
    "0075_sessions_workspace_activity_revision_idx.sql",
    "139b13a478ef0d7fcb306e4ff8a8db15b8f6dead2d21fdc41bf9a3ba56d97e55",
  ],
  [
    "0077_session_attempt_latest_lookup.sql",
    "093c75b5969dc7a1f26085e1696169e936ed4171c44baf88d13ab9907b258064",
  ],
] as const;

describe("governed migration history", () => {
  for (const [file, expectedHash] of governedHashes) {
    test(`${file} retains its shipped bytes`, async () => {
      const content = await readFile(join(migrationsDir, file));
      expect(createHash("sha256").update(content).digest("hex")).toBe(expectedHash);
    });
  }
});
