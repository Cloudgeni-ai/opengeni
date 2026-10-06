import { createHash } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  allocateSandboxV2BackgroundOperation,
  abandonSandboxJournalOperation,
  assertSandboxJournalCommand,
  assertSandboxV2BackgroundCommandControl,
  listSandboxV2BackgroundOwnersForControl,
  loadSandboxV2BackgroundCommandForControl,
  loadSandboxV2BackgroundCredentialGenerationMetadata,
  reserveSandboxJournalCommand,
  requestSandboxV2BackgroundExpiredCredentialCancellation,
  settleSandboxV2BackgroundCommand,
  type Database,
  type SandboxV2BackgroundCommandAuthority,
} from "@opengeni/db";
import {
  getSessionBackgroundCommand,
  projectCommandOutputPage,
  readSessionBackgroundCommandOutput,
  requestSessionBackgroundCommandCancellation,
} from "@opengeni/db/session-background-commands";
import type { RunCredentialsResolution, SessionEvent } from "@opengeni/contracts";
import {
  JournalBindingError,
  JournalStartRequest,
  MachineJournalClient,
  type ChannelAExecArgs,
  type MachineExecTransport,
} from "@opengeni/runtime/sandbox";
import type { SandboxV2TurnMachine } from "./sandbox-v2-turn";
import { sandboxV2CausalActionId } from "./sandbox-v2-command-store";
import { installSandboxV2BackgroundCredentialGeneration } from "./sandbox-v2-credentials";
import {
  createSandboxV2BackgroundCommandController,
  retainSandboxV2BackgroundControlOwner,
} from "./sandbox-v2-background-control";

type ReadInput = { commandId: string; cursor?: string; maxOutputBytes?: number };
const generationId = "background-command:credentials:v1";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Trusted normal-tool composition. Launch belongs to the original live turn;
 * output/control belongs to independently installed current job permission.
 * Only fresh prelaunch custody reads original material. Recovery accepts no
 * broker/renewal and never dispatches a previously bound command again. */
export function createSandboxV2BackgroundCommandTools(
  db: Database,
  machine: SandboxV2TurnMachine,
  options: {
    encryptionKey: Uint8Array;
    resolveOriginal: () => Promise<RunCredentialsResolution>;
    authorizeResources: () => Promise<void>;
    authorizeJob: (authority: SandboxV2BackgroundCommandAuthority) => Promise<void>;
    controlTransport: MachineExecTransport;
    workspaceRoot?: string;
    publishEvents?: (events: SessionEvent[]) => Promise<void>;
  },
) {
  const original = structuredClone(machine.authority);
  options = { ...options, encryptionKey: Uint8Array.from(options.encryptionKey) };
  if (typeof options.authorizeJob !== "function")
    throw new JournalBindingError("Background commands require installed independent authority");
  const root = posix.normalize(options.workspaceRoot ?? "/workspace");
  if (!posix.isAbsolute(root) || root === "/")
    throw new JournalBindingError("Background commands require a workspace root");
  const tenant = {
    accountId: original.accountId,
    workspaceId: original.workspaceId,
    machineId: original.machineId,
  };
  const identity = (commandId: string) => ({ ...tenant, sessionId: original.sessionId, commandId });
  const authorize = (authority: SandboxV2BackgroundCommandAuthority) =>
    options.authorizeJob(structuredClone(authority));
  const publish = async (events: SessionEvent[]) => {
    try {
      if (events.length) await options.publishEvents?.(events);
    } catch {
      /* Durable events remain authoritative. */
    }
  };
  async function lookup(commandId: string) {
    const page = await listSandboxV2BackgroundOwnersForControl(db, tenant, {
      jobId: commandId,
      includeCleared: true,
    });
    const authority = page.items[0]?.authority;
    if (!authority || authority.sessionId !== original.sessionId)
      throw new JournalBindingError("No original background command in this session");
    await authorize(authority);
    return authority;
  }
  const cached = async (input: ReadInput) =>
    readSessionBackgroundCommandOutput(db, {
      ...identity(input.commandId),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    });
  function controller(authority: SandboxV2BackgroundCommandAuthority, signal?: AbortSignal) {
    return createSandboxV2BackgroundCommandController(db, authority, options.controlTransport, {
      authorizeJob: () => authorize(authority),
      ...(signal ? { signal } : {}),
    });
  }
  async function read(input: ReadInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    projectCommandOutputPage({ ...input, rows: [] });
    const authority = await lookup(input.commandId);
    const job = await getSessionBackgroundCommand(db, identity(input.commandId));
    if (!job) throw new JournalBindingError("Background command unavailable");
    let control: string = "output_complete";
    if (job.state === "running" || job.state === "stopping") {
      await requestSandboxV2BackgroundExpiredCredentialCancellation(db, authority);
      const current = await getSessionBackgroundCommand(db, identity(input.commandId));
      const owner = controller(authority, signal);
      const result =
        current?.state === "stopping" ? await owner.cancel(signal) : await owner.observe(signal);
      control = result.state;
      await publish(result.events);
    }
    signal?.throwIfAborted();
    await authorize(authority);
    return { control, ...(await cached(input)) };
  }
  async function wait(input: ReadInput & { waitMs?: number }, signal?: AbortSignal) {
    const waitMs = input.waitMs ?? 10_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 50_000)
      throw new JournalBindingError("Invalid bounded background wait");
    const until = Date.now() + waitMs;
    const budget = waitMs ? AbortSignal.timeout(waitMs) : undefined;
    const combined = budget ? AbortSignal.any([budget, ...(signal ? [signal] : [])]) : signal;
    try {
      let page = await read(input, combined);
      while (!page.terminal && !page.chunks.length && Date.now() < until) {
        await delay(
          Math.min(100, until - Date.now()),
          undefined,
          combined ? { signal: combined } : undefined,
        );
        page = await read(input, combined);
      }
      return page;
    } catch (error) {
      signal?.throwIfAborted();
      if (!budget?.aborted) throw error;
      await lookup(input.commandId);
      return { control: "held", ...(await cached(input)) };
    }
  }
  return {
    read,
    wait,
    cancel: async (input: ReadInput, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      projectCommandOutputPage({ ...input, rows: [] });
      const authority = await lookup(input.commandId);
      await requestSessionBackgroundCommandCancellation(db, {
        ...identity(input.commandId),
        subjectId: `agent:${original.turnId}`,
      });
      signal?.throwIfAborted();
      const result = await controller(authority, signal).cancel(signal);
      await publish(result.events);
      await authorize(authority);
      return { control: result.state, ...(await cached(input)) };
    },
    start: async (sourceCallId: string, input: ChannelAExecArgs, signal?: AbortSignal) => {
      const args = structuredClone(input);
      signal?.throwIfAborted();
      if (
        (args.maxOutputTokens !== undefined &&
          (!Number.isSafeInteger(args.maxOutputTokens) || args.maxOutputTokens < 1)) ||
        (args.yieldTimeMs !== undefined &&
          (!Number.isSafeInteger(args.yieldTimeMs) || args.yieldTimeMs < 0))
      )
        throw new JournalBindingError("Invalid background command output budget");
      const output = {
        ...(args.maxOutputTokens === undefined
          ? {}
          : { maxOutputBytes: Math.min(65_536, args.maxOutputTokens * 4) }),
      };
      if (args.tty || args.runAs)
        throw new JournalBindingError(
          "Background command PTY and alternate user ownership are unavailable",
        );
      const cwd = posix.resolve(root, args.workdir ?? root);
      if (cwd !== root && !cwd.startsWith(root + "/"))
        throw new JournalBindingError("Background command directory is outside the workspace");
      const shell = args.shell ?? "/bin/sh";
      const body = { cmd: args.cmd, cwd, shell, login: args.shell ? (args.login ?? true) : false };
      const context = {
        ...original,
        acceptedActionId: sandboxV2CausalActionId(sourceCallId, "background-command"),
      };
      // Validate all native execution fields before durable allocation.
      JournalStartRequest.parse({
        operationId: "00000000-0000-0000-0000-000000000000",
        bootId: original.instance.bootId,
        diskLineage: original.instance.diskLineage,
        program: shell,
        args: [body.login ? "-lc" : "-c", args.cmd],
        cwd,
        environment: {},
        stdin: false,
        pty: null,
      });
      const jobId = await allocateSandboxV2BackgroundOperation(db, context, {
        requestDigest: createHash("sha256")
          .update(JSON.stringify(["background-command-v1", body]))
          .digest("hex"),
        commandText: args.cmd,
      });
      const authority = { ...original, jobId };
      try {
        await authorize(authority);
        let info = await loadSandboxV2BackgroundCommandForControl(db, authority);
        if (info.abandoned)
          throw new JournalBindingError("Original background allocation was abandoned");
        if (info.command) {
          if (!info.independent)
            throw new JournalBindingError("Bound command has no original independent owner");
        } else {
          await options.authorizeResources();
          const metadata = await loadSandboxV2BackgroundCredentialGenerationMetadata(
            db,
            authority,
            {
              generationId,
              purpose: "provision",
              forceRefresh: false,
            },
          );
          const source = metadata ? undefined : await options.resolveOriginal();
          signal?.throwIfAborted();
          const credentials = await installSandboxV2BackgroundCredentialGeneration(
            db,
            machine,
            { jobId, generationId },
            {
              encryptionKey: options.encryptionKey,
              authorize: async () => {
                await options.authorizeResources();
                await authorize(authority);
              },
              ...(source === undefined ? {} : { source }),
              workspaceRoot: root,
              ...(signal ? { signal } : {}),
            },
          );
          await retainSandboxV2BackgroundControlOwner(db, authority, {
            authorizeJob: () => authorize(authority),
            ...(signal ? { signal } : {}),
          });
          const request = JournalStartRequest.parse({
            operationId: jobId,
            bootId: original.instance.bootId,
            diskLineage: original.instance.diskLineage,
            program: "/usr/bin/env",
            args: [
              "-i",
              "PATH=/usr/local/bin:/usr/bin:/bin",
              "/bin/bash",
              "--noprofile",
              "--norc",
              "-c",
              `set -a; . ${quote(`${credentials.root}/versions/${credentials.versionName}/env`)}; exec ${quote(shell)} ${body.login ? "-lc" : "-c"} ${quote(args.cmd)}`,
            ],
            cwd,
            environment: {},
            stdin: false,
            pty: null,
          });
          const launch = new MachineJournalClient(
            { machineId: original.machineId, instance: original.instance },
            machine.transport,
            {
              reserve: async (command) => {
                await authorize(authority);
                return reserveSandboxJournalCommand(db, context, command);
              },
              assert: async (command, action) => {
                await authorize(authority);
                if (action === "start") {
                  await options.authorizeResources();
                  return assertSandboxJournalCommand(db, context, command, "start");
                }
                if (action === "read" || action === "cancel")
                  return assertSandboxV2BackgroundCommandControl(db, authority, command, action);
                throw new JournalBindingError("Background launch has no input authority");
              },
            },
            { attempts: 1 },
          );
          await launch.start(request, signal);
          info = await loadSandboxV2BackgroundCommandForControl(db, authority);
          if (!info.independent)
            throw new JournalBindingError("Original background owner unavailable after binding");
        }
        return await wait(
          { commandId: jobId, ...output, waitMs: Math.min(50_000, args.yieldTimeMs ?? 10_000) },
          signal,
        );
      } catch (error) {
        // Binding prevents redispatch and abandonment even after a lost reply.
        // Current permission still precedes any cached output returned here.
        const info = await loadSandboxV2BackgroundCommandForControl(db, authority).catch(
          () => null,
        );
        if (info?.command && info.independent && !signal?.aborted) {
          await authorize(authority);
          return { control: "held", ...(await cached({ commandId: jobId, ...output })) };
        }
        try {
          if (await abandonSandboxJournalOperation(db, context, jobId)) {
            const settled = await settleSandboxV2BackgroundCommand(db, authority);
            await publish(settled?.events ?? []);
          }
        } catch {
          /* Original custody and demands remain recoverable. */
        }
        throw error;
      }
    },
  };
}
