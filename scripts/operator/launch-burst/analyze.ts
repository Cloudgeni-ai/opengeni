import { readFile } from "node:fs/promises";
import { correlateTemporal } from "./measurements";

// Offline only. The monitoring owner supplies metadata, never raw Temporal history.
if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3) throw new Error("metadata path required");
    console.log(
      JSON.stringify(correlateTemporal(JSON.parse(await readFile(path, "utf8"))), null, 2),
    );
  } catch {
    console.error(JSON.stringify({ error: "invalid_content_free_temporal_metadata" }));
    process.exitCode = 2;
  }
}
