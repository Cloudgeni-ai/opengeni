#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stableJson } from "@opengeni/contracts";
import {
  listSkillLibraryEntries,
  loadSkillLibrarySkill,
  skillLibraryRepositoryUrl,
} from "@opengeni/runtime/skill-library";

const migrationPath = join(
  import.meta.dir,
  "../packages/db/drizzle/0233_skill_and_integration_authority_cutover.sql",
);
const startMarker = "-- BEGIN GENERATED CURATED SKILL LIBRARY SEED";
const endMarker = "-- END GENERATED CURATED SKILL LIBRARY SEED";

const seed = listSkillLibraryEntries()
  .map((entry) => {
    const loaded = loadSkillLibrarySkill(entry.id, entry.version);
    const files = loaded.skill.files.map((file) => ({
      path: file.path,
      content: file.content,
      byte_size: Buffer.byteLength(file.content, "utf8"),
      content_sha256: sha256(file.content),
    }));
    const totalBytes = files.reduce((total, file) => total + file.byte_size, 0);
    const repositoryUrl = skillLibraryRepositoryUrl(entry.sourceUrl);
    const manifest = {
      schemaVersion: 1,
      kind: "skill",
      source: "library",
      sourceUrl: entry.sourceUrl,
      repositoryUrl,
      version: entry.version,
      sourceCommit: entry.sourceCommit,
      sourcePath: entry.relativePath,
      sourceProvenance: entry.provenance,
      contentSha256: entry.contentSha256,
      fileCount: files.length,
      totalBytes,
    };
    return {
      library_id: entry.id,
      capability_id: `skill:${entry.id}`,
      plugin_key: `skill/library/${entry.id}`,
      version: entry.version,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      tags: [...entry.tags],
      source_url: entry.sourceUrl,
      repository_url: repositoryUrl,
      source_commit: entry.sourceCommit,
      source_path: entry.relativePath,
      source_provenance: entry.provenance,
      content_sha256: entry.contentSha256,
      file_count: files.length,
      total_bytes: totalBytes,
      license: entry.license,
      manifest,
      manifest_digest: sha256(stableJson(manifest)),
      files,
    };
  })
  .sort((left, right) => left.library_id.localeCompare(right.library_id));

const seedJson = JSON.stringify(seed, null, 2);
if (seedJson.includes("$skill_authority_seed$")) {
  throw new Error("Curated Skill seed contains the SQL dollar-quote delimiter");
}
const generated = `${startMarker}
CREATE TEMP TABLE skill_authority_library ON COMMIT DROP AS
SELECT *
FROM jsonb_to_recordset(
  $skill_authority_seed$
${seedJson}
  $skill_authority_seed$::jsonb
) AS seed(
  library_id text,
  capability_id text,
  plugin_key text,
  version text,
  name text,
  description text,
  category text,
  tags jsonb,
  source_url text,
  repository_url text,
  source_commit text,
  source_path text,
  source_provenance text,
  content_sha256 text,
  file_count integer,
  total_bytes integer,
  license text,
  manifest jsonb,
  manifest_digest text,
  files jsonb
);

CREATE UNIQUE INDEX skill_authority_library_id_idx
  ON skill_authority_library (library_id);
CREATE UNIQUE INDEX skill_authority_capability_id_idx
  ON skill_authority_library (capability_id);
${endMarker}`;

const current = await readFile(migrationPath, "utf8");
const start = current.indexOf(startMarker);
const end = current.indexOf(endMarker);
if (start < 0 || end < start) {
  throw new Error(`Generated seed markers are missing from ${migrationPath}`);
}
const next = `${current.slice(0, start)}${generated}${current.slice(end + endMarker.length)}`;

if (process.argv.includes("--check")) {
  if (next !== current) {
    throw new Error(
      "Curated Skill migration seed is stale; run bun scripts/generate-skill-authority-cutover.ts",
    );
  }
  process.stdout.write(`verified ${seed.length} curated Skill migration seeds\n`);
} else {
  await writeFile(migrationPath, next);
  process.stdout.write(`generated ${seed.length} curated Skill migration seeds\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
