import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { BoundedObjectWriteError } from "@opengeni/storage";

import {
  EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE,
  EditableArtifactMaterializer,
  createConfiguredEditableArtifactMaterializer,
  mimeTypeForFormat,
  type ClaimedEditableArtifactMaterialization,
  type EditableArtifactMaterializationStorePort,
  type EditableArtifactMaterializationVerifierPort,
  type EditableArtifactMaterializerDependencies,
  type NativeEditableArtifactMaterializationResult,
  type NativeEditableArtifactMaterializerPort,
  type VerifiedEditableArtifactMaterialization,
} from "../src/editable-artifact-materializer";

const encoder = new TextEncoder();
const OWNER = "materializer-test-1";
const SNAPSHOT = encoder.encode("canonical immutable artifact snapshot");
const OUTPUT = encoder.encode("deterministic office export");

describe("editable artifact materializer", () => {
  test("reconstructs a pinned snapshot and settles only independently verified output", async () => {
    const fixture = createFixture();
    const service = fixture.service();

    const summary = await service.dispatchOnce();

    expect(summary).toEqual({
      claimed: 1,
      succeeded: 1,
      deadLettered: 0,
      retryDeferred: 0,
      leaseLost: 0,
      cancelled: 0,
      claimFailed: false,
    });
    expect(fixture.kernelInputs).toHaveLength(1);
    expect(fixture.kernelInputs[0]).toEqual({
      snapshot: Array.from(SNAPSHOT),
      options: "{}",
      jobId: fixture.job.jobId,
    });
    expect(fixture.store.succeeded).toHaveLength(1);
    expect(fixture.store.succeeded[0]).toMatchObject({
      artifactId: fixture.job.artifactId,
      jobId: fixture.job.jobId,
      owner: OWNER,
      attemptCount: 1,
      byteSize: OUTPUT.byteLength,
      contentHash: hash(OUTPUT),
      mimeType: mimeTypeForFormat("xlsx"),
    });
    expect(fixture.verifierCalls).toHaveLength(1);
    expect(fixture.store.failed).toHaveLength(0);
  });

  test("crash after immutable write safely recomputes and converges on one object and ids", async () => {
    const first = makeJob({ attemptCount: 1 });
    const second = makeJob({ attemptCount: 2 });
    const fixture = createFixture({ batches: [[first], [second]] });
    fixture.store.succeedFailures = 1;

    const service = fixture.service();
    const firstPass = await service.dispatchOnce();
    const firstSettlement = fixture.store.succeedAttempts[0]!;
    const secondPass = await service.dispatchOnce();
    const secondSettlement = fixture.store.succeedAttempts[1]!;

    expect(firstPass.retryDeferred).toBe(1);
    expect(secondPass.succeeded).toBe(1);
    expect(fixture.computeCount).toBe(2);
    expect(fixture.objects.size).toBe(1);
    expect(firstSettlement.objectReference).toBe(secondSettlement.objectReference);
    expect(firstSettlement.resultId).toBe(secondSettlement.resultId);
    expect(firstSettlement.blobRefId).toBe(secondSettlement.blobRefId);
    expect(fixture.store.failed).toHaveLength(0);
  });

  test("a stale lease aborts settlement and never marks success or failure", async () => {
    const fixture = createFixture();
    fixture.store.renewError = leaseFenced();

    const summary = await fixture.service().dispatchOnce();

    expect(summary.leaseLost).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(fixture.store.succeeded).toHaveLength(0);
    expect(fixture.store.failed).toHaveLength(0);
  });

  test("graceful shutdown cancels native work and leaves the fenced job reclaimable", async () => {
    const started = deferred<void>();
    const fixture = createFixture({
      materialize: async ({ signal }) => {
        started.resolve();
        await waitForAbort(signal);
        throw new DOMException("cancelled", "AbortError");
      },
    });
    const abort = new AbortController();
    const running = fixture.service().run(abort.signal);
    await started.promise;

    abort.abort();
    await running;

    expect(fixture.store.succeeded).toHaveLength(0);
    expect(fixture.store.failed).toHaveLength(0);
  });

  test("source hash mismatch is dead-lettered before any output is published", async () => {
    const fixture = createFixture({
      job: makeJob({ sourceContentHash: hash(encoder.encode("other")) }),
    });

    const summary = await fixture.service().dispatchOnce();

    expect(summary.deadLettered).toBe(1);
    expect(fixture.store.failed[0]).toMatchObject({
      errorCode: "source_identity_mismatch",
    });
    expect(fixture.warnings).toContainEqual({
      code: "source_identity_mismatch",
      errorClass: "EditableArtifactMaterializerPermanentError",
      failureStage: "source_reader",
      failureSubcode: "stream_identity",
    });
    expect(fixture.objects.size).toBe(0);
  });

  test("kernel output hash or size mismatch is terminal and never reaches the verifier", async () => {
    const fixture = createFixture({
      materialize: async (input) => {
        await consume(input.snapshot);
        return outputFor(input.job, {
          byteSize: OUTPUT.byteLength + 1,
          contentHash: hash(encoder.encode("wrong")),
        });
      },
    });

    const summary = await fixture.service().dispatchOnce();

    expect(summary.deadLettered).toBe(1);
    expect(fixture.store.failed[0]).toMatchObject({
      errorCode: "output_verification_failed",
    });
    expect(fixture.verifierCalls).toHaveLength(0);
    expect(fixture.store.succeeded).toHaveLength(0);
  });

  test("independent verifier mismatch is terminal", async () => {
    const fixture = createFixture();
    fixture.verifierMismatch = true;

    const summary = await fixture.service().dispatchOnce();

    expect(summary.deadLettered).toBe(1);
    expect(fixture.store.failed[0]).toMatchObject({
      errorCode: "output_verification_failed",
    });
    expect(fixture.store.succeeded).toHaveLength(0);
  });

  test("one poisoned manifest does not block a healthy job in the same batch", async () => {
    const poisoned = makeJob({
      jobId: "22222222222222222222222222222222",
      normalizedOptions: '{"not":"canonical", "spacing":true}',
      optionsHash: hash(encoder.encode('{"not":"canonical", "spacing":true}')),
    });
    const healthy = makeJob({
      jobId: "33333333333333333333333333333333",
      inputSnapshotId: "44444444444444444444444444444444",
    });
    const fixture = createFixture({ batches: [[poisoned, healthy]], batchSize: 2 });

    const summary = await fixture.service().dispatchOnce();

    expect(summary).toMatchObject({ claimed: 2, deadLettered: 1, succeeded: 1 });
    expect(fixture.store.failed[0]).toMatchObject({
      jobId: poisoned.jobId,
      errorCode: "invalid_job_manifest",
    });
    expect(fixture.store.succeeded[0]).toMatchObject({ jobId: healthy.jobId });
  });

  test("attempt ceiling dead-letters without recomputing", async () => {
    const fixture = createFixture({ job: makeJob({ attemptCount: 4 }), maxAttempts: 4 });

    const summary = await fixture.service().dispatchOnce();

    expect(summary.deadLettered).toBe(1);
    expect(fixture.computeCount).toBe(0);
    expect(fixture.store.failed[0]).toMatchObject({ errorCode: "retry_exhausted" });
  });

  test("production composition defaults disabled and fails closed", () => {
    const fixture = createFixture();
    const dependencies = fixture.dependencies();

    expect(
      createConfiguredEditableArtifactMaterializer({
        enabled: false,
        databaseRole: null,
        objectStorageConfigured: false,
      }),
    ).toBeNull();
    expect(() =>
      createConfiguredEditableArtifactMaterializer({
        enabled: true,
        databaseRole: "opengeni_runtime",
        objectStorageConfigured: true,
        dependencies,
        options: { owner: OWNER },
      }),
    ).toThrow("dedicated database role");
    expect(() =>
      createConfiguredEditableArtifactMaterializer({
        enabled: true,
        databaseRole: EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE,
        objectStorageConfigured: false,
        dependencies,
        options: { owner: OWNER },
      }),
    ).toThrow("immutable object storage");
    expect(() =>
      createConfiguredEditableArtifactMaterializer({
        enabled: true,
        databaseRole: EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE,
        objectStorageConfigured: true,
        dependencies: { ...dependencies, kernel: undefined },
        options: { owner: OWNER },
      }),
    ).toThrow("dependencies are incomplete");

    const developmentKernel = {
      ...dependencies.kernel,
      identity: {
        ...dependencies.kernel.identity,
        network: "host" as const,
        sandboxEnforced: false,
        memoryLimitBytes: 0,
        cpuTimeLimitMs: 0,
        fileDescriptorLimit: 0,
        processLimit: 0,
        fileSizeLimitBytes: 0,
      },
    };
    const developmentDependencies = { ...dependencies, kernel: developmentKernel };
    expect(() =>
      createConfiguredEditableArtifactMaterializer({
        enabled: true,
        databaseRole: EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE,
        objectStorageConfigured: true,
        dependencies: developmentDependencies,
        options: { owner: OWNER },
      }),
    ).toThrow("subprocess protocol is not enforced");
    expect(
      createConfiguredEditableArtifactMaterializer({
        enabled: true,
        databaseRole: EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE,
        objectStorageConfigured: true,
        dependencies: developmentDependencies,
        options: { owner: OWNER },
        allowUnsandboxedDevelopment: true,
      }),
    ).toBeInstanceOf(EditableArtifactMaterializer);
  });
});

type FixtureOptions = {
  job?: ClaimedEditableArtifactMaterialization;
  batches?: ClaimedEditableArtifactMaterialization[][];
  batchSize?: number;
  maxAttempts?: number;
  materialize?: NativeEditableArtifactMaterializerPort["materialize"];
};

function createFixture(options: FixtureOptions = {}) {
  const job = options.job ?? makeJob();
  const store = new MemoryStore(options.batches ?? [[job]]);
  const objects = new Map<string, Uint8Array>();
  const kernelInputs: Array<{ snapshot: number[]; options: string; jobId: string }> = [];
  const verifierCalls: unknown[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  let computeCount = 0;
  let verifierMismatch = false;

  const kernel: NativeEditableArtifactMaterializerPort = {
    identity: Object.freeze({
      kind: "native",
      isolation: "subprocess",
      network: "denied",
      officeAutomation: false,
      processProtocolVersion: 1,
      sandboxEnforced: true,
      memoryLimitBytes: 512 * 1024 * 1024,
      cpuTimeLimitMs: 60_000,
      fileDescriptorLimit: 64,
      processLimit: 64,
      fileSizeLimitBytes: 512 * 1024 * 1024,
      maxOutputBytes: 512 * 1024 * 1024,
      kernelVersion: "kernel-1",
      runtimeTarget: "test-native",
      codecVersions: Object.freeze({ "opengeni.xlsx": "codec-1" }),
      fontRegistryHash: hash(encoder.encode("fonts")),
      policyHash: hash(encoder.encode("policy")),
      supportedModelSchemaVersions: Object.freeze([1]),
      supportedOperationProtocolVersions: Object.freeze([1]),
      supportedSnapshotProtocolVersions: Object.freeze([1]),
    }),
    async materialize(input) {
      computeCount += 1;
      if (options.materialize) return await options.materialize(input);
      const snapshot = await consume(input.snapshot);
      kernelInputs.push({
        snapshot: Array.from(snapshot),
        options: new TextDecoder().decode(input.normalizedOptions),
        jobId: input.job.jobId,
      });
      return outputFor(input.job);
    },
  };

  const sourceReader = {
    async open(input: {
      opaqueReference: string;
      maxBytes: number;
      expectedByteSize?: number;
      signal?: AbortSignal;
    }) {
      if (input.signal?.aborted) throw input.signal.reason;
      if (input.opaqueReference !== "immutable:snapshot") throw new Error("missing");
      if (input.expectedByteSize !== undefined && input.expectedByteSize !== SNAPSHOT.byteLength) {
        throw new Error("size mismatch");
      }
      let claimed = false;
      let closed = false;
      return {
        byteSize: SNAPSHOT.byteLength,
        contentType: "application/vnd.opengeni.artifact-snapshot",
        chunks({ signal }: { signal?: AbortSignal } = {}) {
          if (claimed || closed) throw new Error("reader already consumed");
          claimed = true;
          return (async function* () {
            if (signal?.aborted) throw signal.reason;
            yield SNAPSHOT.subarray(0, 7);
            yield SNAPSHOT.subarray(7);
          })();
        },
        async assertUnchanged() {},
        async close() {
          closed = true;
        },
      };
    },
  };

  const outputWriter = {
    async write(input: {
      chunks: AsyncIterable<Uint8Array>;
      contentType: string;
      maxBytes: number;
      expectedByteSize?: number;
      expectedContentHash?: string;
      signal?: AbortSignal;
    }) {
      const bytes = await consume(input.chunks);
      if (bytes.byteLength > input.maxBytes) throw new BoundedObjectWriteError("size_limit");
      if (input.expectedByteSize !== undefined && input.expectedByteSize !== bytes.byteLength) {
        throw new BoundedObjectWriteError("truncated");
      }
      const contentHash = hash(bytes);
      if (input.expectedContentHash !== undefined && input.expectedContentHash !== contentHash) {
        throw new BoundedObjectWriteError("content_hash_mismatch");
      }
      const opaqueReference = `immutable:${contentHash}`;
      objects.set(opaqueReference, bytes);
      return {
        opaqueReference,
        byteSize: bytes.byteLength,
        contentHash,
        contentType: input.contentType,
      };
    },
  };

  const outputVerifier: EditableArtifactMaterializationVerifierPort = {
    async verify(input) {
      verifierCalls.push(input);
      const bytes = objects.get(input.objectReference);
      if (!bytes) throw new Error("missing output");
      const verified: VerifiedEditableArtifactMaterialization = {
        objectReference: input.objectReference,
        byteSize: verifierMismatch ? bytes.byteLength + 1 : bytes.byteLength,
        contentHash: hash(bytes),
        mimeType: input.expectedMimeType,
        format: input.format,
        codecId: input.codecId,
        codecVersion: input.codecVersion,
      };
      return verified;
    },
  };

  const scheduler = {
    sleep(_milliseconds: number, signal: AbortSignal): Promise<void> {
      return waitForAbort(signal);
    },
  };

  const dependencies = (): EditableArtifactMaterializerDependencies => ({
    store,
    sourceReader,
    outputWriter,
    outputVerifier,
    kernel,
    scheduler,
    clock: { now: () => new Date("2026-08-08T12:00:00.000Z") },
    logger: { warn: (_message, attributes) => warnings.push({ ...attributes }) },
  });

  return {
    job,
    store,
    objects,
    kernelInputs,
    verifierCalls,
    warnings,
    get computeCount() {
      return computeCount;
    },
    get verifierMismatch() {
      return verifierMismatch;
    },
    set verifierMismatch(value: boolean) {
      verifierMismatch = value;
    },
    dependencies,
    service: () =>
      new EditableArtifactMaterializer(dependencies(), {
        owner: OWNER,
        batchSize: options.batchSize ?? 1,
        concurrency: 1,
        leaseDurationMs: 10_000,
        leaseRenewIntervalMs: 1_000,
        maxAttempts: options.maxAttempts ?? 20,
      }),
  };
}

class MemoryStore implements EditableArtifactMaterializationStorePort {
  readonly batches: ClaimedEditableArtifactMaterialization[][];
  readonly renewed: unknown[] = [];
  readonly succeedAttempts: Array<Record<string, unknown>> = [];
  readonly succeeded: Array<Record<string, unknown>> = [];
  readonly failed: Array<Record<string, unknown>> = [];
  renewError: unknown = null;
  succeedFailures = 0;

  constructor(batches: ClaimedEditableArtifactMaterialization[][]) {
    this.batches = [...batches];
  }

  async claim(): Promise<readonly ClaimedEditableArtifactMaterialization[]> {
    return this.batches.shift() ?? [];
  }

  async renew(input: Record<string, unknown>): Promise<string> {
    this.renewed.push(input);
    if (this.renewError) throw this.renewError;
    return "2026-08-08T12:02:00.000Z";
  }

  async succeed(input: Record<string, unknown>): Promise<unknown> {
    this.succeedAttempts.push(input);
    if (this.succeedFailures > 0) {
      this.succeedFailures -= 1;
      throw new Error("simulated process/database crash boundary");
    }
    this.succeeded.push(input);
    return input;
  }

  async fail(input: Record<string, unknown>): Promise<unknown> {
    this.failed.push(input);
    return input;
  }
}

function makeJob(
  override: Partial<ClaimedEditableArtifactMaterialization> = {},
): ClaimedEditableArtifactMaterialization {
  const normalizedOptions = override.normalizedOptions ?? "{}";
  return Object.freeze({
    scope: Object.freeze({
      accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
    artifactId: "11111111111111111111111111111111",
    jobId: "12121212121212121212121212121212",
    versionId: "13131313131313131313131313131313",
    modality: "spreadsheet",
    inputSnapshotId: "14141414141414141414141414141414",
    targetHeadSequence: 7,
    stateHash: hash(encoder.encode("state")),
    sourceObjectReference: "immutable:snapshot",
    sourceByteSize: SNAPSHOT.byteLength,
    sourceContentHash: hash(SNAPSHOT),
    sourceMimeType: "application/vnd.opengeni.artifact-snapshot",
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    snapshotProtocolVersion: 1,
    format: "xlsx",
    codecId: "opengeni.xlsx",
    normalizedOptions,
    optionsHash: hash(encoder.encode(normalizedOptions)),
    codecVersion: "codec-1",
    kernelVersion: "kernel-1",
    fontRegistryHash: hash(encoder.encode("fonts")),
    policyHash: hash(encoder.encode("policy")),
    attemptCount: 1,
    leaseOwner: OWNER,
    leaseExpiresAt: "2026-08-08T12:02:00.000Z",
    ...override,
  });
}

function outputFor(
  job: ClaimedEditableArtifactMaterialization,
  override: Partial<NativeEditableArtifactMaterializationResult> = {},
): NativeEditableArtifactMaterializationResult {
  return {
    headSequence: job.targetHeadSequence,
    stateHash: job.stateHash,
    format: job.format,
    mimeType: mimeTypeForFormat(job.format),
    codecId: job.codecId,
    codecVersion: job.codecVersion,
    kernelVersion: job.kernelVersion,
    fontRegistryHash: job.fontRegistryHash,
    policyHash: job.policyHash,
    semanticHash: hash(encoder.encode("semantic-output")),
    chunks: chunks(OUTPUT),
    ...override,
  };
}

async function consume(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const buffers: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    buffers.push(chunk.slice());
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of buffers) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function* chunks(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes.slice();
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function leaseFenced(): Error & { code: "lease_fenced" } {
  return Object.assign(new Error("fenced"), { code: "lease_fenced" as const });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("cancelled", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("cancelled", "AbortError")),
      { once: true },
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
