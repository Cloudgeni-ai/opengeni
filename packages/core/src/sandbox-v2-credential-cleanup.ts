import {
  assertSandboxV2CredentialCleanupCommand,
  assertSandboxV2BackgroundCredentialCleanupCommand,
  loadSandboxV2BackgroundCredentialCleanupForControl,
  loadSandboxV2CredentialCleanupForControl,
  reserveSandboxV2CredentialCleanupCommand,
  reserveSandboxV2BackgroundCredentialCleanupCommand,
  retainSandboxV2CredentialCleanupIntent,
  settleSandboxV2CredentialCleanup,
  settleSandboxV2BackgroundCredentialCleanup,
  type Database,
  type SandboxV2BackgroundCredentialAuthority,
  type SandboxJournalControlAuthority,
} from "@opengeni/db";
import {
  JournalBindingError,
  JournalStartRequest,
  MachineJournalClient,
  journalSpecificationDigest,
  runCredentialRoot,
  type MachineExecTransport,
} from "@opengeni/runtime/sandbox";

/** Fixed v1 maintenance specification. Keep this implementation stable for
 * retained unbound intents; changing the specification requires a new version.
 * It deletes only this original attempt's names and preserves a foreign pointer.
 * Ordinary descriptor/no-follow checks do not certify guest integrity/isolation. */
export function buildSandboxV2CredentialCleanupRequest(
  authority: SandboxJournalControlAuthority,
  operationId: string,
) {
  const context = structuredClone(authority);
  if (
    !/^[0-9a-f-]{36}$/u.test(context.attemptId) ||
    !Number.isSafeInteger(context.executionGeneration) ||
    context.executionGeneration < 0
  )
    throw new JournalBindingError("Credential cleanup requires its original attempt identity");
  const root = runCredentialRoot(context.sessionId);
  const prefix = `${context.attemptId}-${context.executionGeneration}-`;
  return buildCredentialCleanupRequest(context, operationId, root, prefix);
}

/** A job retains its real session scope; its separate directory never selects
 * another session's authority or shares the attempt's activation pointer. */
export function sandboxV2BackgroundCredentialRoot(
  authority: Pick<SandboxV2BackgroundCredentialAuthority, "sessionId" | "jobId">,
): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(authority.jobId))
    throw new JournalBindingError("Job credentials require their original job identity");
  return `${runCredentialRoot(authority.sessionId)}/jobs/${authority.jobId}`;
}

/** Fixed job v1 specification. It removes only this job's versions under its
 * own root. The caller must retain this specification before material delivery
 * and prove its writers physically finished before maintenance can Start. */
export function buildSandboxV2BackgroundCredentialCleanupRequest(
  authority: SandboxV2BackgroundCredentialAuthority,
  operationId: string,
) {
  const context = structuredClone(authority);
  return buildCredentialCleanupRequest(
    context,
    operationId,
    sandboxV2BackgroundCredentialRoot(context),
    `job-${context.jobId}-`,
  );
}

function buildCredentialCleanupRequest(
  context: SandboxJournalControlAuthority,
  operationId: string,
  root: string,
  prefix: string,
) {
  const script = [
    'import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";',
    `const {root,prefix}=${JSON.stringify({ root, prefix })};`,
    "const owns=name => name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length));",
    "const directory=path => openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);",
    'const rootFd=directory(root); const base="/proc/self/fd/"+rootFd;',
    'let versionsFd; try { versionsFd=directory(base+"/versions"); } catch(error) { if(error.code!=="ENOENT") throw error; }',
    'let pointerFd; try { pointerFd=openSync(base+"/current",constants.O_RDONLY|constants.O_NOFOLLOW); } catch(error) { if(error.code!=="ENOENT") throw error; }',
    "if(pointerFd!==undefined) {",
    '  if(fstatSync(pointerFd).size>512) throw Error("Credential pointer unavailable");',
    '  const current=readFileSync(pointerFd,"utf8").trim(); closeSync(pointerFd);',
    '  if(owns(current)) unlinkSync(base+"/current");',
    "}",
    "if(versionsFd!==undefined) {",
    '  const versions="/proc/self/fd/"+versionsFd;',
    '  for(const name of readdirSync(versions)) if(owns(name)||name.startsWith(".stage-")&&owns(name.slice(7))) rmSync(versions+"/"+name,{recursive:true,force:true});',
    "  closeSync(versionsFd);",
    "}",
    'for(const name of readdirSync(base)) if(name.startsWith(".next-")&&owns(name.slice(6))) unlinkSync(base+"/"+name);',
    'closeSync(rootFd); process.stdout.write("cleaned");',
  ].join("\n");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `umask 077; /bin/mkdir -p -- ${quote(root)} && exec /usr/bin/flock --exclusive ${quote(root + "/activation.lock")} /usr/local/bin/bun --no-env-file --config=/dev/null --no-addons -e ${quote(script)}`;
  return JournalStartRequest.parse({
    operationId,
    bootId: context.instance.bootId,
    diskLineage: context.instance.diskLineage,
    program: "/usr/bin/env",
    args: [
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      command,
    ],
    cwd: "/",
    environment: {},
    stdin: false,
    pty: null,
  });
}

/** Retain the narrow maintenance writer BEFORE native credential delivery. */
export async function retainSandboxV2GuestCredentialCleanup(
  db: Database,
  authority: SandboxJournalControlAuthority,
) {
  const context = structuredClone(authority);
  return retainSandboxV2CredentialCleanupIntent(db, context, (operationId) =>
    journalSpecificationDigest(buildSandboxV2CredentialCleanupRequest(context, operationId)),
  );
}

/** One bounded original maintenance pass. Revoked agent commands receive no
 * launch authority. This separate retained fixed cleanup can start once after
 * the original closed owner and all other durable writers settle. A bound
 * operation is observed only; unknown/lost/reply loss cannot replace it. */
export async function reconcileSandboxV2GuestCredentialCleanup(
  db: Database,
  authority: SandboxJournalControlAuthority,
  transport: MachineExecTransport,
  options: {
    signal?: AbortSignal;
    journal?: ConstructorParameters<typeof MachineJournalClient>[3];
  } = {},
): Promise<{ state: "absent" | "held" | "complete"; operationId?: string }> {
  const context = structuredClone(authority);
  options = { ...options };
  options.signal?.throwIfAborted();
  const row = await loadSandboxV2CredentialCleanupForControl(db, context);
  if (!row) return { state: "absent" };
  if (row.proof) return { state: "complete", operationId: row.operationId };
  if (!row.eligible) return { state: "held", operationId: row.operationId };
  const client = new MachineJournalClient(
    { machineId: context.machineId, instance: context.instance },
    {
      exec: (request) =>
        transport.exec({
          ...request,
          signal: AbortSignal.any([
            AbortSignal.timeout(15_000),
            ...(request.signal ? [request.signal] : []),
          ]),
        }),
    },
    {
      reserve: (command) => reserveSandboxV2CredentialCleanupCommand(db, context, command),
      assert: (command, action) => {
        if (action !== "start" && action !== "read")
          throw new JournalBindingError("Credential maintenance has no input/cancel authority");
        return assertSandboxV2CredentialCleanupCommand(db, context, command, action);
      },
    },
    { ...options.journal, attempts: 1 },
  );
  let command = row.binding;
  let observed;
  if (command === null) {
    const request = buildSandboxV2CredentialCleanupRequest(context, row.operationId);
    if (journalSpecificationDigest(request) !== row.specificationDigest)
      throw new JournalBindingError("Original credential cleanup specification changed");
    const started = await client.start(request, options.signal);
    command = started.command;
    observed = started.observation;
  } else
    observed = await client.read(command, { stdout: 0, stderr: 0, bytes: 128 }, options.signal);
  if (
    observed.state === "exited" &&
    observed.receipt?.leaderExitCode === 0 &&
    observed.stdout.eof &&
    observed.stderr.eof &&
    observed.stdout.offset === 0 &&
    observed.stdout.nextOffset === 7 &&
    observed.stdout.data === "Y2xlYW5lZA==" &&
    observed.stderr.nextOffset === 0
  ) {
    await settleSandboxV2CredentialCleanup(db, context, command, observed);
    return { state: "complete", operationId: row.operationId };
  }
  return { state: "held", operationId: row.operationId };
}

/** Job maintenance never renews the origin turn. Its retained exact purpose
 * can run after the job and its credential writer physically finish, including
 * when resource grants expired. It cannot decrypt, use stdin or cancel jobs. */
export async function reconcileSandboxV2BackgroundGuestCredentialCleanup(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  transport: MachineExecTransport,
  options: {
    signal?: AbortSignal;
    journal?: ConstructorParameters<typeof MachineJournalClient>[3];
  } = {},
): Promise<{ state: "absent" | "held" | "complete"; operationId?: string }> {
  const context = structuredClone(authority);
  options = { ...options };
  options.signal?.throwIfAborted();
  const row = await loadSandboxV2BackgroundCredentialCleanupForControl(db, context);
  if (!row) return { state: "absent" };
  if (row.proof) return { state: "complete", operationId: row.operationId };
  if (!row.eligible) return { state: "held", operationId: row.operationId };
  const client = new MachineJournalClient(
    { machineId: context.machineId, instance: context.instance },
    {
      exec: (request) =>
        transport.exec({
          ...request,
          signal: AbortSignal.any([
            AbortSignal.timeout(15_000),
            ...(request.signal ? [request.signal] : []),
          ]),
        }),
    },
    {
      reserve: (command) =>
        reserveSandboxV2BackgroundCredentialCleanupCommand(db, context, command),
      assert: (command, action) => {
        if (action !== "start" && action !== "read")
          throw new JournalBindingError("Job credential maintenance has no input/cancel authority");
        return assertSandboxV2BackgroundCredentialCleanupCommand(db, context, command, action);
      },
    },
    { ...options.journal, attempts: 1 },
  );
  let command = row.binding;
  let observed;
  if (command === null) {
    const request = buildSandboxV2BackgroundCredentialCleanupRequest(context, row.operationId);
    if (journalSpecificationDigest(request) !== row.specificationDigest)
      throw new JournalBindingError("Original job cleanup specification changed");
    const started = await client.start(request, options.signal);
    command = started.command;
    observed = started.observation;
  } else
    observed = await client.read(command, { stdout: 0, stderr: 0, bytes: 128 }, options.signal);
  if (
    observed.state === "exited" &&
    observed.receipt?.leaderExitCode === 0 &&
    observed.stdout.eof &&
    observed.stderr.eof &&
    observed.stdout.offset === 0 &&
    observed.stdout.nextOffset === 7 &&
    observed.stdout.data === "Y2xlYW5lZA==" &&
    observed.stderr.nextOffset === 0
  ) {
    await settleSandboxV2BackgroundCredentialCleanup(db, context, command, observed);
    return { state: "complete", operationId: row.operationId };
  }
  return { state: "held", operationId: row.operationId };
}
