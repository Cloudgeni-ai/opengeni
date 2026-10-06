import { decodeSandboxJournalPage, type SessionEvent } from "@opengeni/contracts";
import {
  abandonUnboundSandboxV2BackgroundCommand,
  assertSandboxV2BackgroundCommandControl,
  captureSandboxV2BackgroundCommandOutputWithEvents,
  loadSandboxV2BackgroundCommandForControl,
  retainSandboxV2BackgroundOwner,
  listSandboxV2BackgroundOwnersForControl,
  requestSandboxV2BackgroundExpiredCredentialCancellation,
  settleSandboxV2BackgroundCommand,
  type Database,
  type SandboxV2BackgroundCommandAuthority,
} from "@opengeni/db";
import {
  JournalBindingError,
  MachineJournalClient,
  type MachineExecTransport,
} from "@opengeni/runtime/sandbox";
import { reconcileSandboxV2BackgroundGuestCredentialCleanup } from "./sandbox-v2-credential-cleanup";

type ControlResult = {
  operationId: string;
  state: "unbound" | "abandoned" | "held" | "captured" | "output_complete";
  captured: boolean;
  /** Already durable; the ordinary worker publishes these to its event bus. */
  events: SessionEvent[];
};

/** Register original custody only after a separately installed current job
 * owner has authorized it. No transport, broker or renewal is accepted here;
 * A later binding routes this exact job separately while custody/demand remain
 * retained. Registration itself does not exclude an unbound allocation. */
export async function retainSandboxV2BackgroundControlOwner(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
  options: { authorizeJob: () => Promise<void>; signal?: AbortSignal },
) {
  const context = structuredClone(authority);
  const authorize = options.authorizeJob;
  const signal = options.signal;
  if (typeof authorize !== "function")
    throw new JournalBindingError("Background owner requires current independent permission");
  signal?.throwIfAborted();
  await authorize();
  signal?.throwIfAborted();
  return retainSandboxV2BackgroundOwner(db, context);
}

/** Observe/control one already-retained native job under current job control
 * permission. This owner accepts no broker, Start, stdin, foreground adoption
 * or replacement command. Unregistered jobs remain originating-turn writers. */
export function createSandboxV2BackgroundCommandController(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
  transport: MachineExecTransport,
  options: {
    /** Current permission to observe/control this job, independent of an ended
     * turn's credential owner. This callback grants no credential renewal. */
    authorizeJob: () => Promise<void>;
    signal?: AbortSignal;
    bytes?: number;
  },
) {
  const context = structuredClone(authority);
  options = { ...options };
  const authorize = options.authorizeJob;
  const bytes = options.bytes ?? 64 * 1024;
  if (
    typeof authorize !== "function" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 1024 * 1024
  )
    throw new JournalBindingError(
      "Background control requires current job permission and bounded output",
    );
  const journal = new MachineJournalClient(
    { machineId: context.machineId, instance: context.instance },
    {
      exec: (request) =>
        transport.exec({
          ...request,
          signal: AbortSignal.any([
            AbortSignal.timeout(15_000),
            ...(request.signal ? [request.signal] : []),
            ...(options.signal ? [options.signal] : []),
          ]),
        }),
    },
    {
      reserve: async () => {
        throw new JournalBindingError("Background control cannot Start commands");
      },
      assert: async (command, action) => {
        if (action !== "read" && action !== "cancel")
          throw new JournalBindingError("Background control cannot execute or supply stdin");
        await authorize();
        await assertSandboxV2BackgroundCommandControl(db, context, command, action);
      },
    },
    { attempts: 1 },
  );
  async function observe(signal?: AbortSignal): Promise<ControlResult> {
    options.signal?.throwIfAborted();
    signal?.throwIfAborted();
    await authorize();
    const info = await loadSandboxV2BackgroundCommandForControl(db, context);
    if (!info.command) {
      const settlement = info.abandoned
        ? await settleSandboxV2BackgroundCommand(db, context)
        : null;
      return {
        operationId: context.jobId,
        state: info.abandoned ? "abandoned" : "unbound",
        captured: false,
        events: settlement?.events ?? [],
      };
    }
    if (info.outputComplete) {
      const settlement = await settleSandboxV2BackgroundCommand(db, context);
      return {
        operationId: context.jobId,
        state: "output_complete",
        captured: false,
        events: settlement?.events ?? [],
      };
    }
    const expected = info.command;
    const observation = await journal.read(
      expected.command,
      {
        stdout: expected.stdout.offset,
        stderr: expected.stderr.offset,
        bytes,
      },
      signal,
    );
    if (["not_found", "unknown", "lost"].includes(observation.state))
      return { operationId: context.jobId, state: "held", captured: false, events: [] };
    if (
      observation.stdout.data === "" &&
      observation.stderr.data === "" &&
      !["exited", "cancelled"].includes(observation.state)
    )
      return { operationId: context.jobId, state: "held", captured: false, events: [] };
    const stdout = decodeSandboxJournalPage(
      expected.stdout.remainder,
      [Buffer.from(observation.stdout.data, "base64")],
      observation.stdout.eof,
    );
    const stderr = decodeSandboxJournalPage(
      expected.stderr.remainder,
      [Buffer.from(observation.stderr.data, "base64")],
      observation.stderr.eof,
    );
    await authorize();
    options.signal?.throwIfAborted();
    signal?.throwIfAborted();
    const capture = await captureSandboxV2BackgroundCommandOutputWithEvents(db, context, {
      expected,
      next: {
        ...expected,
        revision: expected.revision + 1,
        stdout: { offset: observation.stdout.nextOffset, remainder: stdout.remainder },
        stderr: { offset: observation.stderr.nextOffset, remainder: stderr.remainder },
      },
      observation,
      stdout: stdout.text,
      stderr: stderr.text,
    });
    const complete =
      capture.captured &&
      ["exited", "cancelled"].includes(observation.state) &&
      observation.stdout.eof &&
      observation.stderr.eof;
    const settlement = complete ? await settleSandboxV2BackgroundCommand(db, context) : null;
    return {
      operationId: context.jobId,
      state: complete ? "output_complete" : capture.captured ? "captured" : "held",
      captured: capture.captured,
      events: [...capture.events, ...(settlement?.events ?? [])],
    };
  }
  return {
    observe,
    cancel: async (signal?: AbortSignal): Promise<ControlResult> => {
      options.signal?.throwIfAborted();
      signal?.throwIfAborted();
      await authorize();
      const info = await loadSandboxV2BackgroundCommandForControl(db, context);
      if (info.outputComplete || info.abandoned) return observe(signal);
      if (!info.command) {
        const abandoned = await abandonUnboundSandboxV2BackgroundCommand(db, context);
        const settlement = abandoned ? await settleSandboxV2BackgroundCommand(db, context) : null;
        return {
          operationId: context.jobId,
          state: abandoned ? "abandoned" : "held",
          captured: false,
          events: settlement?.events ?? [],
        };
      }
      await journal.cancel(info.command.command, signal);
      // Cancellation's response never substitutes for complete captured output.
      // Read again at the current retained cursor, using the same operation.
      return observe(signal);
    },
  };
}

/** One finite pass for original job custody, including incomplete prelaunch
 * registration and output recovery after physical exit. The host supplies
 * current independent control permission. Unregistered jobs stay turn writers.
 * Static expiry requests cancellation; it never reuses an ended turn broker.
 * Lost/unknown/outage retains job custody for a later pass. */
export async function reconcileSandboxV2BackgroundJobs(
  db: Database,
  tenant: { accountId: string; workspaceId: string; machineId: string },
  transport: MachineExecTransport,
  options: {
    authorizeJob: (authority: SandboxV2BackgroundCommandAuthority) => Promise<void>;
    limit?: number;
    afterJobId?: string;
    jobId?: string;
    signal?: AbortSignal;
    /** Read/control callers may retain cleanup for the ordinary custody owner. */
    cleanup?: boolean;
  },
) {
  options = { ...options };
  const authorize = options.authorizeJob;
  if (typeof authorize !== "function")
    throw new JournalBindingError("Background recovery requires current independent permission");
  options.signal?.throwIfAborted();
  const page = await listSandboxV2BackgroundOwnersForControl(db, tenant, {
    ...options,
    includeUnregistered: true,
  });
  const events: SessionEvent[] = [];
  const items: { jobId: string; state: "held" | "output_complete" | "settled" | "deferred" }[] = [];
  for (const candidate of page.items) {
    options.signal?.throwIfAborted();
    const authority = structuredClone(candidate.authority);
    const authorizeCurrent = () => authorize(structuredClone(authority));
    try {
      await authorizeCurrent();
      options.signal?.throwIfAborted();
      await requestSandboxV2BackgroundExpiredCredentialCancellation(db, authority);
      const info = await loadSandboxV2BackgroundCommandForControl(db, authority);
      const controller = createSandboxV2BackgroundCommandController(db, authority, transport, {
        authorizeJob: authorizeCurrent,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const result =
        info.state === "stopping" ? await controller.cancel() : await controller.observe();
      events.push(...result.events);
      if (!["output_complete", "abandoned"].includes(result.state)) {
        items.push({ jobId: authority.jobId, state: "held" });
        continue;
      }
      if (options.cleanup === false) {
        items.push({ jobId: authority.jobId, state: "output_complete" });
        continue;
      }
      await authorizeCurrent();
      options.signal?.throwIfAborted();
      const cleanup = await reconcileSandboxV2BackgroundGuestCredentialCleanup(
        db,
        authority,
        transport,
        {
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      items.push({
        jobId: authority.jobId,
        state: cleanup.state === "complete" ? "settled" : "held",
      });
    } catch {
      options.signal?.throwIfAborted();
      items.push({ jobId: authority.jobId, state: "deferred" });
    }
  }
  return { items, events, nextJobId: page.nextJobId };
}
