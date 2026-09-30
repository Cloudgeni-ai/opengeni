import { describe, expect, test } from "bun:test";
import {
  EditableArtifactLiveServer,
  InMemoryEditableArtifactLiveTicketStore,
  WebCryptoEditableArtifactLiveTokens,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactStateHash,
  type EditableArtifactLiveServerDependencies,
  type EditableArtifactLiveServerFrame,
  type EditableArtifactLiveSourceSessionAuthority,
  type OpenEditableArtifactLiveInput,
} from "@opengeni/core";

const scope = {
  accountId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002",
};
const artifactId = editableArtifactId("1".repeat(32));
const actor = {
  kind: "human" as const,
  subjectId: "user:viewer",
  replicaId: editableArtifactReplicaId("2".repeat(16)),
};
const stateHash = editableArtifactStateHash(`sha256:${"3".repeat(64)}`);
const authority: EditableArtifactLiveSourceSessionAuthority = {
  sessionId: "30000000-0000-4000-8000-000000000003",
  grant: {
    ...scope,
    subjectId: actor.subjectId,
    principalKind: "human_session",
    permissions: ["sessions:read", "artifacts:read", "artifacts:publish"],
  },
};

function fixture(bootstrapDelayMs = 0) {
  const frames: EditableArtifactLiveServerFrame[] = [];
  let now = Date.now();
  const sleeps = new Set<{ due: number; resolve: () => void }>();
  const clock = { now: () => new Date(now) };
  const server = new EditableArtifactLiveServer(
    {
      authorization: { authorize: async () => ({ allowed: true, revision: 1 }) },
      domain: {} as EditableArtifactLiveServerDependencies["domain"],
      tickets: new InMemoryEditableArtifactLiveTicketStore(),
      tokens: new WebCryptoEditableArtifactLiveTokens(),
      clock,
      scheduler: {
        sleep: async (ms, signal) =>
          await new Promise<void>((resolve, reject) => {
            const pending = {
              due: now + ms,
              resolve: () => {
                sleeps.delete(pending);
                signal.removeEventListener("abort", abort);
                resolve();
              },
            };
            const abort = () => {
              sleeps.delete(pending);
              signal.removeEventListener("abort", abort);
              reject(signal.reason);
            };
            if (signal.aborted) abort();
            else {
              sleeps.add(pending);
              signal.addEventListener("abort", abort, { once: true });
            }
          }),
      },
      read: {
        readBootstrap: async () => {
          now += bootstrapDelayMs;
          return {
            modality: "document",
            headSequence: 0,
            nativeRevision: 0,
            stateHash,
            minimumReplaySequence: 0,
            resumeAccepted: true,
            resumeSequence: 0,
            resumeStateHash: stateHash,
            snapshot: null,
          };
        },
        readHead: async () => ({
          modality: "document",
          headSequence: 0,
          nativeRevision: 0,
          stateHash,
          minimumReplaySequence: 0,
        }),
        readTransactions: async () => ({
          transactions: [],
          headSequence: 0,
          minimumReplaySequence: 0,
        }),
        readCommittedTransaction: async () => null,
        acknowledgeReplica: async () => undefined,
      },
      hints: { subscribe: async () => () => undefined },
      invalidations: { subscribe: async () => () => undefined },
    },
    { reauthorizeIntervalMs: 100, reconcileIntervalMs: 100 },
  );
  const mint = (sourceSessionAuthority: typeof authority | null = authority) =>
    server.mintTicket({
      scope,
      artifactId,
      actor,
      modality: "document",
      allowEdit: true,
      ...(sourceSessionAuthority ? { sourceSessionAuthority } : {}),
    });
  const open = (
    token: string,
    authorizeSourceSession?: OpenEditableArtifactLiveInput["authorizeSourceSession"],
    signal?: AbortSignal,
  ) =>
    server.openLive({
      token,
      artifactId,
      protocolVersion: 2,
      resume: {
        modality: "document",
        localCursor: 0,
        localStateHash: stateHash,
        localNativeRevision: 0,
        requireSnapshot: false,
      },
      sink: {
        send: async (frame) => {
          frames.push(frame);
        },
        bufferedBytes: () => 0,
        close: () => undefined,
      },
      ...(authorizeSourceSession ? { authorizeSourceSession } : {}),
      ...(signal ? { signal } : {}),
    });
  return {
    server,
    mint,
    open,
    frames,
    pendingSleeps: () => sleeps.size,
    async tick(milliseconds = 100) {
      now += milliseconds;
      for (let count = 0; count < 100; count += 1) {
        for (const pending of sleeps) if (pending.due <= now) pending.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe("source-session-bound editor admission", () => {
  test("caller cancellation aborts stalled authorization and cleans up all timers", async () => {
    const f = fixture();
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const opening = f.open(
      (await f.mint()).token,
      async (_ticket, _permission, _tx, value) => {
        signal = value;
        enter();
        return await new Promise<boolean>(() => {});
      },
      caller.signal,
    );
    const rejected = opening.then(
      () => null,
      (error: unknown) => error,
    );
    await entered;
    caller.abort(new Error("viewer closed"));
    expect(await rejected).not.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(f.frames).toHaveLength(0);
    expect(f.pendingSleeps()).toBe(0);
  });
  test("stalled source reauthorization cannot outlive the independent lease", async () => {
    const f = fixture();
    let stall = false;
    let stalledSignal: AbortSignal | undefined;
    let checks = 0;
    const session = await f.open(
      (await f.mint()).token,
      async (_ticket, _permission, _tx, signal) => {
        checks += 1;
        if (!stall) return true;
        stalledSignal = signal;
        return await new Promise<boolean>(() => {});
      },
    );
    const before = checks;
    stall = true;
    await f.tick(100);
    expect(checks).toBeGreaterThan(before);
    expect(stalledSignal?.aborted).toBe(false);
    await f.tick(14_900);
    expect(await session.closed).toMatchObject({ reason: "ticket_expired", retryable: true });
    expect(stalledSignal?.aborted).toBe(true);
    expect(f.pendingSleeps()).toBe(0);
  });

  test("stalled bootstrap authorization settles on lease expiry without emitting frames", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const opening = f.open((await f.mint()).token, async (_ticket, _permission, _tx, value) => {
      signal = value;
      enter();
      return await new Promise<boolean>(() => {});
    });
    // Observe the rejection immediately rather than leaving an orphaned promise.
    const rejected = opening.then(
      () => null,
      (error: unknown) => error,
    );
    await entered;
    await f.tick(15_000);
    expect(await rejected).not.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(f.frames).toHaveLength(0);
    expect(f.pendingSleeps()).toBe(0);
  });
  test("authenticates the complete binding and preserves atomic one-use consumption", async () => {
    const f = fixture();
    const ticket = await f.mint();
    const nonce = ticket.token.split(".ogs2.")[0]!;
    await expect(f.open(nonce, async () => true)).rejects.toMatchObject({
      code: "ticket_replayed",
    });
    const changed = `${nonce}.ogs1.${Buffer.from(JSON.stringify({ ...authority, sessionId: crypto.randomUUID() })).toString("base64url")}`;
    await expect(f.open(changed, async () => true)).rejects.toMatchObject({
      code: "ticket_replayed",
    });
    const session = await f.open(ticket.token, async (record) => {
      expect(record.sourceSessionAuthority).toEqual(authority);
      return true;
    });
    await expect(f.open(ticket.token, async () => true)).rejects.toMatchObject({
      code: "ticket_replayed",
    });
    await session.close();
  });

  test("cannot downgrade a source-bound ticket to artifact-only admission", async () => {
    const f = fixture();
    const ticket = await f.mint();
    await expect(f.open(ticket.token)).rejects.toMatchObject({ code: "permission_changed" });
    expect(f.frames).toHaveLength(0);
  });

  test("maximum linked-user identities fit the authenticated 4 KiB token", async () => {
    const f = fixture();
    const text = (length: number) =>
      Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
        String.fromCharCode(33 + (byte % 90)),
      ).join("");
    const subjectId = `user:${text(251)}`;
    const linked = {
      sessionId: authority.sessionId,
      grant: {
        ...authority.grant,
        subjectId,
      },
      externalContinuation: {
        identity: { externalId: text(1024), source: text(200) },
        actor: {
          accountId: scope.accountId,
          authenticatingApiKeyId: crypto.randomUUID(),
          externalIdentityId: crypto.randomUUID(),
          externalSubjectId: `external_user:${crypto.randomUUID()}`,
          externalAuthorizationRevision: 1,
          effectiveSubjectId: subjectId,
          actingMode: "linked_native" as const,
          linkId: crypto.randomUUID(),
          linkRevision: 1,
        },
      },
    };
    const ticket = await f.server.mintTicket({
      scope,
      artifactId,
      modality: "document",
      actor: { ...actor, subjectId },
      allowEdit: true,
      sourceSessionAuthority: linked,
    });
    expect(new TextEncoder().encode(ticket.token).byteLength).toBeLessThanOrEqual(4096);
    const session = await f.open(ticket.token, async (record) => {
      expect(record.sourceSessionAuthority).toEqual(linked);
      return true;
    });
    await session.close();
  });

  test("denies a revoked source before bootstrap and closes periodically after revocation", async () => {
    const denied = fixture();
    const ticket = await denied.mint();
    await expect(denied.open(ticket.token, async () => false)).rejects.toMatchObject({
      code: "permission_changed",
    });
    expect(denied.frames).toHaveLength(0);

    const live = fixture();
    let allowed = true;
    let checks = 0;
    const session = await live.open((await live.mint()).token, async () => {
      checks += 1;
      return allowed;
    });
    expect(checks).toBeGreaterThan(0);
    allowed = false;
    await live.tick();
    expect((await session.closed).reason).toBe("permission_changed");
  });

  test("retains unbound native tickets for additive compatibility", async () => {
    const f = fixture();
    const session = await f.open((await f.mint(null)).token);
    await session.close();
  });

  test("source lease forces proxy renewal and host revocation blocks the successor", async () => {
    const f = fixture();
    let hostAllowed = true;
    const proxyMint = async () => {
      if (!hostAllowed) throw new Error("Product session revoked");
      return f.mint();
    };
    const session = await f.open((await proxyMint()).token, async () => true);
    await f.tick(14_999);
    let closed = false;
    void session.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    hostAllowed = false;
    await f.tick(1);
    expect(await session.closed).toMatchObject({
      reason: "ticket_expired",
      retryable: true,
      requiresSnapshot: false,
    });
    await expect(proxyMint()).rejects.toThrow("Product session revoked");
  });

  test("unbound native sockets do not inherit the product lease", async () => {
    const f = fixture();
    const session = await f.open((await f.mint(null)).token);
    await f.tick(15_000);
    let closed = false;
    void session.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await session.close();
  });

  test("a delayed bootstrap cannot send frames after the source lease deadline", async () => {
    const f = fixture(16_000);
    await expect(f.open((await f.mint()).token, async () => true)).rejects.toMatchObject({
      code: "ticket_expired",
      retryable: true,
    });
    expect(f.frames).toHaveLength(0);
  });
});
