import {
  applySessionArchiveBulk,
  validateSessionArchivePlan,
  type SessionArchiveOperatorProgress,
} from "@opengeni/core";
import { SessionArchivePlanRequest } from "@opengeni/contracts/session-archive";
import { OpenGeniClient } from "@opengeni/sdk";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type CommonArgs = {
  baseUrl: string;
  apiKeyEnv: string;
};

export type SessionArchiveOperatorArgs =
  | (CommonArgs & {
      command: "plan";
      workspaceId: string;
      action: "archive" | "unarchive";
      roots: string[];
      outputPath: string;
    })
  | (CommonArgs & {
      command: "apply";
      planPath: string;
      approvedManifestChecksum: string;
      confirmedWorkspaceId: string;
      receiptOutputPath: string;
    });

const repositoryRoot = resolve(import.meta.dir, "..");

function usage(): string {
  return `Usage:
  bun run session-archive:operator -- plan \\
    --workspace <uuid> --action archive --root <root-uuid> [--root <uuid> ...] \\
    --out </private/path/plan.json> [--base-url <url>]

  bun run session-archive:operator -- plan \\
    --workspace <uuid> --action unarchive --root <root-uuid>=<seal-uuid> \\
    --out </private/path/plan.json> [--base-url <url>]

  bun run session-archive:operator -- apply \\
    --plan </private/path/plan.json> \\
    --approved-checksum <sha256:...> --confirm-workspace <uuid> \\
    --receipt-out </private/path/receipts.json> [--base-url <url>]

Authentication is read only from OPENGENI_API_KEY by default. Override the
variable name with --api-key-env; raw API keys are never accepted as arguments.
Manifest and receipt paths inside the public repository are rejected.`;
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseSessionArchiveOperatorArgs(values: string[]): SessionArchiveOperatorArgs {
  const command = values[0];
  if (command !== "plan" && command !== "apply") {
    throw new Error(usage());
  }
  let baseUrl = process.env.OPENGENI_BASE_URL ?? "http://127.0.0.1:8000";
  let apiKeyEnv = "OPENGENI_API_KEY";
  let workspaceId: string | undefined;
  let action: "archive" | "unarchive" | undefined;
  const roots: string[] = [];
  let outputPath: string | undefined;
  let planPath: string | undefined;
  let approvedManifestChecksum: string | undefined;
  let confirmedWorkspaceId: string | undefined;
  let receiptOutputPath: string | undefined;

  for (let index = 1; index < values.length; index += 1) {
    const flag = values[index]!;
    const take = (): string => {
      const value = requiredValue(values, index, flag);
      index += 1;
      return value;
    };
    if (flag === "--base-url") baseUrl = take();
    else if (flag === "--api-key-env") apiKeyEnv = take();
    else if (flag === "--workspace") workspaceId = take();
    else if (flag === "--action") {
      const value = take();
      if (value !== "archive" && value !== "unarchive") {
        throw new Error("--action must be archive or unarchive");
      }
      action = value;
    } else if (flag === "--root") roots.push(take());
    else if (flag === "--out") outputPath = take();
    else if (flag === "--plan") planPath = take();
    else if (flag === "--approved-checksum") approvedManifestChecksum = take();
    else if (flag === "--confirm-workspace") confirmedWorkspaceId = take();
    else if (flag === "--receipt-out") receiptOutputPath = take();
    else throw new Error(`Unknown argument: ${flag}\n\n${usage()}`);
  }

  if (command === "plan") {
    if (!workspaceId || !action || roots.length === 0 || !outputPath) {
      throw new Error(`plan requires --workspace, --action, at least one --root, and --out`);
    }
    return { command, baseUrl, apiKeyEnv, workspaceId, action, roots, outputPath };
  }
  if (!planPath || !approvedManifestChecksum || !confirmedWorkspaceId || !receiptOutputPath) {
    throw new Error(
      "apply requires --plan, --approved-checksum, --confirm-workspace, and --receipt-out",
    );
  }
  return {
    command,
    baseUrl,
    apiKeyEnv,
    planPath,
    approvedManifestChecksum,
    confirmedWorkspaceId,
    receiptOutputPath,
  };
}

function pathIsInsideRepository(path: string): boolean {
  const fromRepository = relative(repositoryRoot, path);
  return fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository));
}

export function assertPrivateSessionArchivePath(path: string): string {
  const absolute = resolve(path);
  if (pathIsInsideRepository(absolute)) {
    throw new Error(`Session archive manifests and evidence must stay outside ${repositoryRoot}`);
  }
  return absolute;
}

async function resolvePrivateInputPath(path: string): Promise<string> {
  return assertPrivateSessionArchivePath(await realpath(path));
}

async function readPrivateJson(path: string): Promise<unknown> {
  const absolute = await resolvePrivateInputPath(path);
  return JSON.parse(await readFile(absolute, "utf8")) as unknown;
}

async function preparePrivateOutputPath(path: string): Promise<string> {
  const lexicalPath = assertPrivateSessionArchivePath(path);
  await mkdir(dirname(lexicalPath), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(lexicalPath));
  const outputPath = assertPrivateSessionArchivePath(join(parent, basename(lexicalPath)));
  try {
    await lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return outputPath;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing private artifact ${outputPath}`);
}

async function writePrivateJson(outputPath: string, value: unknown): Promise<string> {
  const parent = dirname(outputPath);
  const temporaryPath = join(parent, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return outputPath;
}

function parseRoots(action: "archive" | "unarchive", values: string[]) {
  return SessionArchivePlanRequest.parse({
    action,
    roots: values.map((value) => {
      const separator = value.indexOf("=");
      const rootSessionId = separator === -1 ? value : value.slice(0, separator);
      const targetSealId = separator === -1 ? null : value.slice(separator + 1);
      return { rootSessionId, targetSealId };
    }),
  }).roots;
}

function clientFor(args: CommonArgs): OpenGeniClient {
  const apiKey = process.env[args.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Required API key environment variable ${args.apiKeyEnv} is not set`);
  }
  return new OpenGeniClient({ baseUrl: args.baseUrl, apiKey });
}

function printProgress(progress: SessionArchiveOperatorProgress): void {
  const disposition = progress.replay ? "verified replay" : "committed and verified";
  console.error(`[${progress.rootIndex + 1}/${progress.rootCount}] root ${disposition}`);
}

export async function runSessionArchiveOperator(args: SessionArchiveOperatorArgs): Promise<number> {
  if (args.command === "plan") {
    const roots = parseRoots(args.action, args.roots);
    const preparedOutputPath = await preparePrivateOutputPath(args.outputPath);
    const client = clientFor(args);
    const plan = await client.planSessionArchive(args.workspaceId, {
      action: args.action,
      roots,
    });
    const validated = validateSessionArchivePlan(plan);
    const outputPath = await writePrivateJson(preparedOutputPath, {
      ...plan,
      manifest: validated.manifest,
      manifestChecksum: validated.manifestChecksum,
    });
    console.error(`Validated read-only plan: ${validated.manifestChecksum}`);
    console.error(
      `Coverage: ${validated.manifest.totalMemberCount} sessions across ${validated.manifest.roots.length} roots`,
    );
    console.error(`Private plan written exclusively to ${outputPath}`);
    if (!validated.canApply) {
      console.error("Plan has blockers; no source mutation occurred.");
      return 2;
    }
    return 0;
  }

  const plan = validateSessionArchivePlan(await readPrivateJson(args.planPath));
  const preparedReceiptOutputPath = await preparePrivateOutputPath(args.receiptOutputPath);
  if (args.approvedManifestChecksum !== plan.manifestChecksum) {
    throw new Error("--approved-checksum does not match the validated plan");
  }
  if (args.confirmedWorkspaceId.toLowerCase() !== plan.manifest.workspaceId) {
    throw new Error("--confirm-workspace does not match the validated plan");
  }
  if (!plan.canApply) {
    throw new Error("The validated plan contains blockers; generate a fresh blocker-free plan");
  }
  const client = clientFor(args);
  const result = await applySessionArchiveBulk({
    client,
    manifest: plan.manifest,
    approvedManifestChecksum: args.approvedManifestChecksum,
    onProgress: printProgress,
  });
  const outputPath = await writePrivateJson(preparedReceiptOutputPath, {
    format: "opengeni.session-archive-receipt-bundle",
    version: 1,
    workspaceId: plan.manifest.workspaceId,
    action: plan.manifest.action,
    manifestChecksum: result.manifestChecksum,
    rootCount: result.rootCount,
    totalMemberCount: result.memberCount,
    appliedRootCount: result.appliedRootCount,
    replayedRootCount: result.replayedRootCount,
    evidence: result.evidence,
  });
  console.error(`All ${result.rootCount} roots have verified durable receipts.`);
  console.error(`Private receipt evidence written exclusively to ${outputPath}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runSessionArchiveOperator(
      parseSessionArchiveOperatorArgs(process.argv.slice(2)),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
