import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as RuntimePosture from "../packages/db/src/runtime-posture";

export type RuntimePostureBaseline = {
  schemaVersion: 1;
  status: "bootstrap" | "production";
  sourceCommit: string;
  release: string | null;
};

/** Historical production image from the cancelled OPE-822 upgrade rehearsal. */
export const PRE_COMPATIBILITY_PRODUCTION_SOURCE = "bcc60cd80f2fd557e9f64beee38c1562d629de8c";

export function parseRuntimePostureBaseline(value: unknown): RuntimePostureBaseline {
  const pin = value as Partial<RuntimePostureBaseline> | null;
  if (
    pin?.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(pin.sourceCommit ?? "") ||
    !["bootstrap", "production"].includes(pin.status ?? "") ||
    (pin.status === "bootstrap" ? pin.release !== null : !pin.release?.trim())
  ) {
    throw new Error(
      "Invalid runtime posture baseline: require an immutable source SHA and explicit release status",
    );
  }
  return pin as RuntimePostureBaseline;
}

export async function readRuntimePostureBaseline(root: string): Promise<RuntimePostureBaseline> {
  return parseRuntimePostureBaseline(
    JSON.parse(await readFile(join(root, "scripts/runtime-posture-baseline.json"), "utf8")),
  );
}

export function assertBaselineAdvanceScope(
  changedPaths: readonly string[],
  alreadyPinned: boolean,
) {
  if (!alreadyPinned || !changedPaths.includes("scripts/runtime-posture-baseline.json")) return;
  const sourceChanges = changedPaths.filter(
    (path) =>
      path !== "scripts/runtime-posture-baseline.json" &&
      !path.startsWith("docs/") &&
      !path.startsWith(".changeset/"),
  );
  if (sourceChanges.length > 0) {
    throw new Error(
      `Advance the production baseline in a separate pin-only PR, not alongside source changes: ${sourceChanges.join(", ")}`,
    );
  }
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base || !/^[a-f0-9]{40}$/.test(base))
    throw new Error("usage: bun scripts/runtime-posture-baseline.ts <base-sha>");
  const root = process.cwd();
  const paths = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  let alreadyPinned = false;
  try {
    execFileSync("git", ["cat-file", "-e", `${base}:scripts/runtime-posture-baseline.json`], {
      cwd: root,
      stdio: "ignore",
    });
    alreadyPinned = true;
  } catch {
    // The one bootstrap PR is the only base without a pin.
  }
  const pin = await readRuntimePostureBaseline(root);
  if (!alreadyPinned && pin.status !== "bootstrap")
    throw new Error("The first baseline must explicitly declare bootstrap status");
  assertBaselineAdvanceScope(paths, alreadyPinned);
  console.log(`Validated ${pin.status} runtime posture baseline ${pin.sourceCommit}`);
}

/**
 * Run BOTH the inspector and evaluator from the pinned source, not today's
 * evaluator with yesterday's table list. The only executable external import
 * is drizzle-orm (the query adapter); binary-owned relative dependencies are
 * extracted alongside it. A newly added dependency fails closed until this
 * extraction closure is updated. No live tag, main branch, or current source
 * is a fallback for a missing pin.
 */
export async function loadRuntimePostureBaseline(root: string, sourceCommit: string) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Baseline must be a full commit SHA");
  const directory = await mkdtemp(join(root, ".runtime-posture-baseline-"));
  try {
    const postureSource = execFileSync(
      "git",
      ["show", `${sourceCommit}:packages/db/src/runtime-posture.ts`],
      { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(join(directory, "runtime-posture.ts"), postureSource);
    for (const name of [
      "role-relationships.ts",
      ...(postureSource.includes('"./runtime-posture-legacy-routines.json"')
        ? ["runtime-posture-legacy-routines.json"]
        : []),
    ]) {
      const source = execFileSync("git", ["show", `${sourceCommit}:packages/db/src/${name}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      await writeFile(join(directory, name), source);
    }
    const module = (await import(
      pathToFileURL(join(directory, "runtime-posture.ts")).href
    )) as typeof RuntimePosture;
    return { module, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
