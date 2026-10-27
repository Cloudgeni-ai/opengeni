/** Offline code-only staging. Never imports/executes the operator or reads credentials. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const operatorSources = {
  "control.ts": "3e20c5d27698d5d9c67cafff995fd65c1e3bc4858c50c48ce8a0fa5dcc907cc7",
  "cloud-auth.ts": "4f59741315bf07cce77e1071e9eb8dedef61dcfcf16105d9c1392bceaa29f7cc",
  "service-config.ts": "7d24e00a0b3cc39f92e5da5b0dfae6e1d82da264ef3367d56adf575074f58a64",
  "service-limits.ts": "e87e1db1f993054fc5d084d2793a5db8bc793d0819fdf653fa3a62118ca81dfc",
  "stopped-reconciliation.ts": "744d91752cf86f32895f5489d30eee27ba9d25c0114e05d45d302520b0fd2ffd",
  "stopped-lineage.ts": "733288450d075e093b98ae3f98b90d57b56e7ee79eaee4730119d57bad77f5e7",
} as const;
export function portableControlSource(source: string): string {
  if ((source.match(/import\.meta\.dir/g)?.length ?? 0) !== 3)
    throw Error("Unexpected control receipt path closure");
  return source.replaceAll("import.meta.dir", '"/work/operator"');
}
export async function stageOperatorCode(
  source: string,
  output: string,
  hashes: Record<string, string> = operatorSources,
) {
  const files = await Promise.all(
    Object.entries(hashes).map(async ([name, expected]) => {
      if (!/^[a-z-]+\.ts$/.test(name)) throw Error("Invalid source filename");
      const bytes = await readFile(join(source, name));
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
        throw Error(`Operator source mismatch: ${name}`);
      // Preserve the reviewed original provenance, but package the tracked
      // settlement reader with current durable-effect schema support.
      if (name === "stopped-reconciliation.ts" && hashes === operatorSources)
        return {
          name,
          bytes: await readFile(
            new URL("../../docs/merge-batcher-admin/stopped-reconciliation.ts", import.meta.url),
          ),
        };
      // Only path location changes: original write/temp/rename ordering remains.
      // This generated operator is separately reviewed and gets a new hash.
      if (name === "control.ts") {
        if (hashes === operatorSources)
          return {
            name,
            bytes: Buffer.from(portableControlSource(bytes.toString())),
          };
      }
      return { name, bytes };
    }),
  );
  // Exclusive directory creation deliberately refuses prior/partial staging.
  // There is no overwrite, seed recovery, deployment receipt or state reset.
  await mkdir(output);
  for (const { name, bytes } of files) await writeFile(join(output, name), bytes, { flag: "wx" });
  await writeFile(
    join(output, "source-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        originalSources: hashes,
        sources: Object.fromEntries(
          files.map(({ name, bytes }) => [name, createHash("sha256").update(bytes).digest("hex")]),
        ),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output)
    throw Error("Usage: minimal-watchdog-package.ts REVIEWED_OPERATOR NEW_CODE_DIRECTORY");
  await stageOperatorCode(source, output);
}
