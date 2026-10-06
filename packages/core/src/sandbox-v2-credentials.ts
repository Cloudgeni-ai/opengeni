import { createHash } from "node:crypto";
import type { RunCredentialsResolution } from "@opengeni/contracts";
import {
  sandboxV2CredentialWriterIdentity,
  sandboxV2BackgroundCredentialSetupId,
  type Database,
} from "@opengeni/db";
import { normalizeRunCredentialsResolution, runCredentialRoot } from "@opengeni/runtime/sandbox";
import { JournalBindingError } from "@opengeni/runtime/sandbox";
import { executeSandboxV2SetupStep } from "./sandbox-v2-setup";
import type { SandboxV2TurnMachine } from "./sandbox-v2-turn";
import {
  retainSandboxV2GuestCredentialCleanup,
  sandboxV2BackgroundCredentialRoot,
} from "./sandbox-v2-credential-cleanup";
import { createSandboxV2BackgroundCredentialGenerationOwner } from "./sandbox-v2-background-credential-owner";

const credentialWriter = [
  'import { mkdirSync, chmodSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  "const input = JSON.parse(await Bun.stdin.text());",
  "process.umask(0o077);",
  "const {root, versionName, activation} = input;",
  "const material = input.material ?? { environment:{}, files:[], fileEnvironment:{} };",
  'const pointer = join(root,"current");',
  'const current = existsSync(pointer) ? readFileSync(pointer,"utf8").trim() : null;',
  'if (activation && current !== activation.previousVersionName && current !== versionName) throw Error("Credential activation predecessor changed");',
  'const versions = join(root, "versions");',
  'const stage = join(versions, ".stage-" + versionName);',
  "const version = join(versions, versionName);",
  "mkdirSync(versions, {recursive:true, mode:0o700});",
  "chmodSync(root, 0o700); chmodSync(versions, 0o700);",
  'mkdirSync(join(stage, "files"), {recursive:true, mode:0o700});',
  'const quote = value => "\\x27" + value.replaceAll("\\x27", "\\x27\\\\\\x27\\x27") + "\\x27";',
  'const environment = Object.entries(material.environment).map(([name,value]) => "export " + name + "=" + quote(value));',
  'environment.push(...Object.entries(material.fileEnvironment).map(([name,path]) => "export " + name + "=" + quote(join(version,"files",path))));',
  'writeFileSync(join(stage,"env"), environment.join("\\n") + "\\n", {mode:0o600});',
  "for (const file of material.files) {",
  '  const path = join(stage,"files",file.path);',
  "  mkdirSync(dirname(path), {recursive:true, mode:0o700});",
  '  writeFileSync(path,file.content,{mode:Number.parseInt(file.mode ?? "0600",8)});',
  "}",
  "renameSync(stage, version);",
  'writeFileSync(join(root,".next-"+versionName),versionName+"\\n",{mode:0o600});',
  'renameSync(join(root,".next-"+versionName),pointer);',
  'process.stdout.write(input.material === null ? "not_applicable" : "installed");',
].join("\n");

/** Install one immutable host-resolved credential generation through retained
 * stdin actions. The resolver must recover the original generation on retry;
 * renewal needs a distinct retained generation ID. Reuse ordinary scope/path/
 * expiry bounds. Secrets never enter command text, manifest, output or capture.
 * Ordered delivery additionally holds an OS lock and compares the predecessor
 * pointer. A null generation publishes an empty version, clearing old material.
 * Original cleanup is retained before delivery and reconciled after closure.
 * Guest integrity and live-worker admission remain separate release gates. */
type CredentialDeliveryOptions = {
  resolveGeneration: (generationId: string) => Promise<RunCredentialsResolution>;
  environment: () => Promise<Record<string, string>>;
  workspaceRoot?: string;
  signal?: AbortSignal;
  activation?: { previousVersionName: string | null };
  authorizeWrite?: () => Promise<void>;
};

export async function installSandboxV2CredentialGeneration(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { setupId: string; generationId: string },
  options: CredentialDeliveryOptions,
): Promise<{ root: string; versionName: string; installed: boolean }> {
  input = structuredClone(input);
  options = { ...options };
  const authority = structuredClone(machine.authority);
  if (!input.generationId || input.generationId.length > 512)
    throw new JournalBindingError("Credential delivery requires a retained generation identity");
  const root = runCredentialRoot(authority.sessionId);
  await retainSandboxV2GuestCredentialCleanup(db, authority);
  const generation = createHash("sha256").update(input.generationId).digest("hex");
  const versionName = `${authority.attemptId}-${authority.executionGeneration}-${generation}`;
  return deliverCredentialGeneration(db, machine, input, options, root, versionName);
}

/** Copy the already-authorized original into an independently sealed job
 * generation before any guest writer starts. Only the original live turn can
 * deliver it; the job root and cleanup demand survive attempt cleanup. */
export async function installSandboxV2BackgroundCredentialGeneration(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { jobId: string; generationId: string },
  options: {
    encryptionKey: Uint8Array;
    authorize: () => Promise<void>;
    source?: RunCredentialsResolution;
    workspaceRoot?: string;
    signal?: AbortSignal;
  },
): Promise<{ root: string; versionName: string; installed: boolean }> {
  input = structuredClone(input);
  options = { ...options };
  const authority = { ...structuredClone(machine.authority), jobId: input.jobId };
  const setupId = sandboxV2BackgroundCredentialSetupId(input.jobId);
  const root = sandboxV2BackgroundCredentialRoot(authority);
  const generation = createHash("sha256").update(input.generationId).digest("hex");
  const versionName = `job-${input.jobId}-${generation}`;
  const owner = createSandboxV2BackgroundCredentialGenerationOwner(
    db,
    authority,
    { generationId: input.generationId, purpose: "provision", forceRefresh: false },
    options,
  );
  // Retention installs both sealed original and fixed cleanup custody in one
  // canonical transaction. Resolver values never choose a different writer.
  await owner.resolveGeneration();
  return deliverCredentialGeneration(
    db,
    machine,
    { setupId, generationId: input.generationId },
    {
      resolveGeneration: owner.resolveGeneration,
      authorizeWrite: owner.authorizeGeneration,
      environment: async () => ({}),
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    root,
    versionName,
  );
}

async function deliverCredentialGeneration(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { setupId: string; generationId: string },
  options: CredentialDeliveryOptions,
  root: string,
  versionName: string,
) {
  const authority = structuredClone(machine.authority);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const writer = `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/bun --no-env-file --config=/dev/null --no-addons -e ${quote(credentialWriter)}`;
  const command = `umask 077; /bin/mkdir -p -- ${quote(root)} && exec /usr/bin/flock --exclusive ${quote(`${root}/activation.lock`)} ${writer}`;
  const result = await executeSandboxV2SetupStep(
    db,
    machine,
    {
      setupId: input.setupId,
      stepId: sandboxV2CredentialWriterIdentity(input.setupId, input.generationId).stepId,
      command: { cmd: command, shell: "/bin/bash", login: false, yieldTimeMs: 0 },
    },
    {
      // Platform writer startup receives no workspace dotenv/config/loader
      // environment. Credential material crosses only the retained stdin path.
      environment: async () => ({}),
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.authorizeWrite ? { authorizeWrite: options.authorizeWrite } : {}),
      stdin: async () => {
        const resolution = await options.resolveGeneration(input.generationId);
        const material = normalizeRunCredentialsResolution(resolution, authority);
        return JSON.stringify({
          root,
          versionName,
          activation: options.activation ?? { previousVersionName: null },
          material: material
            ? {
                environment: material.environment,
                files: material.files,
                fileEnvironment: material.fileEnvironment,
              }
            : null,
        });
      },
    },
  );
  if (!["installed", "not_applicable"].includes(result.stdout))
    throw new JournalBindingError("Credential generation acknowledgement is unavailable");
  return { root, versionName, installed: result.stdout === "installed" };
}
