import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  RunCredentialsResolution,
  SandboxV2CredentialGenerationDefinition,
  SandboxV2CredentialTicket,
} from "@opengeni/contracts";
import {
  activateSandboxV2CredentialTicket,
  loadSandboxV2CredentialOwner,
  reserveSandboxV2CredentialRenewal,
  retainSandboxV2CredentialOwner,
  SandboxV2CredentialGenerationError,
  sandboxV2CredentialWriterIdentity,
  type Database,
  type SandboxV2CredentialOwnerState,
} from "@opengeni/db";
import { createSandboxV2CredentialGenerationOwner } from "./sandbox-v2-credential-owner";
import { installSandboxV2CredentialGeneration } from "./sandbox-v2-credentials";
import { retainSandboxV2GuestCredentialCleanup } from "./sandbox-v2-credential-cleanup";
import type { SandboxV2TurnMachine } from "./sandbox-v2-turn";

export type SandboxV2ActiveCredentials = {
  ticket: SandboxV2CredentialTicket;
  resolution: RunCredentialsResolution;
};
function fail(): never {
  throw new SandboxV2CredentialGenerationError();
}

/** Attempt-owned recovery and renewal. A timer supplies its original expected
 * predecessor; overlapping workers reuse the durable pending ticket. Material
 * is encrypted before native input, and activation consumes exact completion.
 * An unknown writer is retained, never replaced by a fresh generation.
 *
 * The pointer lock/order check is normal coordination, not a guest integrity
 * guarantee. A foreign attempt's pointer requires separate quiesced cleanup;
 * this owner never clears it, infers expiry-based quiescence, or bypasses grants. */
export function createSandboxV2CredentialLifecycleOwner(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { setupId: string; initialGenerationId: string },
  options: {
    encryptionKey: Uint8Array;
    authorize: () => Promise<void>;
    resolve: (
      definition: SandboxV2CredentialGenerationDefinition,
    ) => Promise<RunCredentialsResolution>;
    environment: () => Promise<Record<string, string>>;
    workspaceRoot?: string;
    signal?: AbortSignal;
    /** Synchronous host MCP replacement. The ordinal guard prevents a late
     * completion in this observer from replacing newer adopted headers. */
    onActivate?: (value: SandboxV2ActiveCredentials) => void;
  },
) {
  if (
    !(options.encryptionKey instanceof Uint8Array) ||
    options.encryptionKey.length !== 32 ||
    typeof options.authorize !== "function" ||
    typeof options.resolve !== "function" ||
    (options.onActivate !== undefined && typeof options.onActivate !== "function")
  )
    fail();
  sandboxV2CredentialWriterIdentity(input.setupId, input.initialGenerationId);
  input = structuredClone(input);
  options = { ...options, encryptionKey: Uint8Array.from(options.encryptionKey) };
  machine = {
    ...machine,
    authority: structuredClone(machine.authority),
    capabilities: { ...machine.capabilities },
  };
  const authority = machine.authority;
  let adopted: SandboxV2ActiveCredentials | null = null;
  let inFlight: Promise<SandboxV2ActiveCredentials> | null = null;
  const generationOwners = new Map<
    string,
    ReturnType<typeof createSandboxV2CredentialGenerationOwner>
  >();
  const generationOwner = (ticket: SandboxV2CredentialTicket) => {
    const id = ticket.definition.generationId;
    let owner = generationOwners.get(id);
    if (!owner) {
      const definition = structuredClone(ticket.definition);
      owner = createSandboxV2CredentialGenerationOwner(db, authority, definition, {
        encryptionKey: options.encryptionKey,
        authorize: options.authorize,
        resolve: () => options.resolve(structuredClone(definition)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      generationOwners.set(id, owner);
    }
    return owner;
  };
  const versionName = (ticket: SandboxV2CredentialTicket) =>
    `${authority.attemptId}-${authority.executionGeneration}-${createHash("sha256").update(ticket.definition.generationId).digest("hex")}`;
  const authorize = async () => {
    options.signal?.throwIfAborted();
    await options.authorize();
    options.signal?.throwIfAborted();
  };
  const load = () => loadSandboxV2CredentialOwner(db, authority, input.setupId);
  const adopt = async (): Promise<SandboxV2ActiveCredentials> => {
    await authorize();
    const head = await load();
    if (head.pending || !head.active) fail();
    await generationOwner(head.active).authorizeGeneration();
    let candidate = adopted;
    if (
      !candidate ||
      candidate.ticket.definition.generationId !== head.active.definition.generationId
    ) {
      candidate = {
        ticket: structuredClone(head.active),
        resolution: await generationOwner(head.active).resolveGeneration(),
      };
    }
    await authorize();
    const current = await load();
    if (current.pending || !isDeepStrictEqual(current.active, candidate.ticket)) fail();
    if (
      adopted &&
      (adopted.ticket.ordinal > candidate.ticket.ordinal ||
        (adopted.ticket.ordinal === candidate.ticket.ordinal &&
          !isDeepStrictEqual(adopted.ticket, candidate.ticket)))
    )
      fail();
    if (!adopted || adopted.ticket.ordinal < candidate.ticket.ordinal) {
      // Callback failure leaves this observer unadopted. Retrying replays the
      // same activated generation; it cannot reserve or mint its successor.
      options.onActivate?.(structuredClone(candidate));
      adopted = structuredClone(candidate);
      // Bound host metadata retention; ciphertext remains in its durable owner.
      generationOwners.clear();
    }
    return structuredClone(candidate);
  };
  const complete = async (
    head: SandboxV2CredentialOwnerState,
  ): Promise<SandboxV2ActiveCredentials> => {
    const pending = head.pending;
    if (!pending) return adopt();
    const owner = generationOwner(pending);
    const resolution = await owner.resolveGeneration();
    await installSandboxV2CredentialGeneration(
      db,
      machine,
      { setupId: input.setupId, generationId: pending.definition.generationId },
      {
        environment: options.environment,
        resolveGeneration: async (generationId) => {
          if (generationId !== pending.definition.generationId) fail();
          await owner.authorizeGeneration();
          return structuredClone(resolution);
        },
        activation: { previousVersionName: head.active ? versionName(head.active) : null },
        authorizeWrite: async () => {
          await authorize();
          const current = await load();
          if (!isDeepStrictEqual(current.pending, pending)) fail();
          await owner.authorizeGeneration();
        },
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    await authorize();
    await activateSandboxV2CredentialTicket(db, authority, {
      setupId: input.setupId,
      ticket: pending,
    });
    return adopt();
  };
  const singleFlight = (
    run: () => Promise<SandboxV2ActiveCredentials>,
  ): Promise<SandboxV2ActiveCredentials> => {
    if (!inFlight) {
      const operation = run();
      inFlight = operation;
      void operation
        .finally(() => {
          if (inFlight === operation) inFlight = null;
        })
        .catch(() => undefined);
    }
    return inFlight.then((value) => structuredClone(value));
  };
  return {
    setupId: input.setupId,
    initialGenerationId: input.initialGenerationId,
    ensure: () =>
      singleFlight(async () => {
        await authorize();
        // Recovery ownership starts before broker resolution too. A failed
        // mint can leave a retained owner without any guest delivery; its
        // eventual receipt still needs the original fixed cleanup proof.
        await retainSandboxV2GuestCredentialCleanup(db, authority);
        return complete(await retainSandboxV2CredentialOwner(db, authority, input));
      }),
    renew: (expectedGenerationId: string) =>
      singleFlight(async () => {
        await authorize();
        const head = await reserveSandboxV2CredentialRenewal(db, authority, {
          setupId: input.setupId,
          expectedGenerationId,
        });
        // Stale timers never complete a newer observer's pending successor.
        if (head.active?.definition.generationId !== expectedGenerationId) return adopt();
        return complete(head);
      }),
    authorizeCurrent: async (): Promise<void> => {
      for (let contention = 0; contention < 100; contention++) {
        await authorize();
        // Join only this owner's already-started lifecycle operation. Dispatch
        // cannot complete a foreign pending ticket or mint a replacement.
        if (inFlight) {
          await inFlight;
          continue;
        }
        try {
          const head = await load();
          if (head.pending || !head.active) fail();
          if (!adopted || !isDeepStrictEqual(adopted.ticket, head.active)) {
            await adopt();
            return;
          }
          // No repeated decryption/cloning of large credential payloads or
          // broker refresh on the ordinary completed dispatch path.
          await generationOwner(head.active).authorizeGeneration();
          return;
        } catch (error) {
          // A local renewal can begin after the first check. Recheck authority
          // after its original result; all other failures stay unavailable.
          if (!(error instanceof SandboxV2CredentialGenerationError) || !inFlight) throw error;
          await inFlight;
        }
      }
      fail();
    },
  };
}
export type SandboxV2CredentialLifecycleOwner = ReturnType<
  typeof createSandboxV2CredentialLifecycleOwner
>;
