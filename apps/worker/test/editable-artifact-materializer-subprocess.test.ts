import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createNativeEditableArtifactSubprocessPort } from "../src/editable-artifact-materializer-subprocess";
import { createDevelopmentEditableArtifactProcessLauncher } from "../src/editable-artifact-materializer-launcher";
import type { ClaimedEditableArtifactMaterialization } from "../src/editable-artifact-materializer";

const source = new TextEncoder().encode("canonical-snapshot");
const staticHash = `sha256:${"1".repeat(64)}`;
let directory = "";
let executable = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "opengeni-materializer-codec-"));
  executable = join(directory, "opengeni-artifact-materializer");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "fixtures/artifact-materializer-codec.ts"),
      "--outfile",
      executable,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await build.exited;
  if (code !== 0) throw new Error(await new Response(build.stderr).text());
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("native editable artifact materializer subprocess", () => {
  test("probes the enforced identity and streams one framed result", async () => {
    const port = await createNativeEditableArtifactSubprocessPort(options());
    const job = makeJob();
    const abort = new AbortController();
    const result = await port.materialize({
      job,
      normalizedOptions: new TextEncoder().encode("{}"),
      snapshot: chunks(source),
      signal: abort.signal,
    });
    const bytes = await consume(result.chunks);

    expect(port.identity).toMatchObject({
      kind: "native",
      isolation: "subprocess",
      network: "denied",
      sandboxEnforced: true,
      memoryLimitBytes: 128 * 1024 * 1024,
      fileDescriptorLimit: 64,
      processLimit: 64,
      fileSizeLimitBytes: 128 * 1024 * 1024,
    });
    expect(new TextDecoder().decode(bytes)).toBe("native-codec-output");
    expect(result).toMatchObject({
      headSequence: job.targetHeadSequence,
      stateHash: job.stateHash,
      codecId: job.codecId,
      codecVersion: job.codecVersion,
      byteSize: bytes.byteLength,
      contentHash: hash(bytes),
    });

    await port.verifyMaterialization({
      format: "xlsx",
      codecId: job.codecId,
      codecVersion: job.codecVersion,
      expectedSemanticHash: staticHash,
      byteSize: bytes.byteLength,
      chunks: chunks(bytes),
      signal: new AbortController().signal,
    });
  });

  test("fails closed when parent launcher isolation is not verified", async () => {
    await expect(
      createNativeEditableArtifactSubprocessPort({
        ...options(),
        launcher: {
          ...testLauncher(),
          identity: { ...testLauncher().identity, sandboxEnforced: false },
        } as never,
      }),
    ).rejects.toThrow("launcher isolation is not verified");
  });

  test("fails closed when any parent resource ceiling is absent", async () => {
    for (const field of ["fileDescriptorLimit", "processLimit", "fileSizeLimitBytes"] as const) {
      await expect(
        createNativeEditableArtifactSubprocessPort({
          ...options(),
          launcher: {
            ...testLauncher(),
            identity: { ...testLauncher().identity, [field]: 0 },
          } as never,
        }),
      ).rejects.toThrow("launcher isolation is not verified");
    }
  });

  test("explicit local development preserves typed authority and reports no sandbox", async () => {
    const launcher = await createDevelopmentEditableArtifactProcessLauncher({
      materializerExecutable: executable,
      explicitlyEnabled: true,
      nodeEnvironment: "development",
    });
    const port = await createNativeEditableArtifactSubprocessPort({
      ...options(),
      launcher,
      allowUnsandboxedDevelopment: true,
      childEnvironment: {
        NODE_ENV: "development",
        OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST:
          "/tmp/opengeni/installation.development.json",
        OPENGENI_ARTIFACT_TOOL_ENTRY: "/tmp/opengeni/skill-facade-entry.mjs",
      },
    });
    expect(port.identity).toMatchObject({
      isolation: "subprocess",
      network: "host",
      sandboxEnforced: false,
      memoryLimitBytes: 0,
      cpuTimeLimitMs: 0,
      fileDescriptorLimit: 0,
      processLimit: 0,
      fileSizeLimitBytes: 0,
    });
  });

  test("development launcher and subprocess both require an explicit non-production opt-in", async () => {
    await expect(
      createDevelopmentEditableArtifactProcessLauncher({
        materializerExecutable: executable,
        explicitlyEnabled: false,
        nodeEnvironment: "development",
      }),
    ).rejects.toThrow("forbidden outside development");
    await expect(
      createDevelopmentEditableArtifactProcessLauncher({
        materializerExecutable: executable,
        explicitlyEnabled: true,
        nodeEnvironment: "production",
      }),
    ).rejects.toThrow("forbidden outside development");

    const launcher = await createDevelopmentEditableArtifactProcessLauncher({
      materializerExecutable: executable,
      explicitlyEnabled: true,
      nodeEnvironment: "development",
    });
    await expect(
      createNativeEditableArtifactSubprocessPort({
        ...options(),
        launcher,
        childEnvironment: {
          NODE_ENV: "development",
          OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST:
            "/tmp/opengeni/installation.development.json",
          OPENGENI_ARTIFACT_TOOL_ENTRY: "/tmp/opengeni/skill-facade-entry.mjs",
        },
      }),
    ).rejects.toThrow("launcher isolation is not verified");
    await expect(
      createNativeEditableArtifactSubprocessPort({
        ...options(),
        launcher,
        allowUnsandboxedDevelopment: true,
        childEnvironment: {
          OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/installation.json",
          OPENGENI_ARTIFACT_TOOL_ENTRY: "/opt/opengeni/skill-facade-entry.mjs",
        },
      }),
    ).rejects.toThrow("runtime authority modes differ");
  });

  test("abort kills a hung codec subprocess", async () => {
    const port = await createNativeEditableArtifactSubprocessPort({
      ...options(),
      wallTimeoutMs: 5_000,
    });
    const abort = new AbortController();
    const pending = port.materialize({
      job: makeJob({
        normalizedOptions: '{"hang":true}',
        optionsHash: hash(new TextEncoder().encode('{"hang":true}')),
      }),
      normalizedOptions: new TextEncoder().encode('{"hang":true}'),
      snapshot: chunks(source),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 25);

    await expect(pending).rejects.toBeDefined();
  });

  test("wall timeout kills a hung codec subprocess without relying on cancellation", async () => {
    const port = await createNativeEditableArtifactSubprocessPort({
      ...options(),
      wallTimeoutMs: 25,
    });
    const normalizedOptions = '{"hang":true}';
    await expect(
      port.materialize({
        job: makeJob({
          normalizedOptions,
          optionsHash: hash(new TextEncoder().encode(normalizedOptions)),
        }),
        normalizedOptions: new TextEncoder().encode(normalizedOptions),
        snapshot: chunks(source),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeDefined();
  });

  test("a parent output cap may be stricter than the child capability and is enforced", async () => {
    const port = await createNativeEditableArtifactSubprocessPort({
      ...options(),
      maxOutputBytes: 8,
    });
    expect(port.identity.maxOutputBytes).toBe(8);
    await expect(
      port.materialize({
        job: makeJob(),
        normalizedOptions: new TextEncoder().encode("{}"),
        snapshot: chunks(source),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "output_size_limit" });
  });

  test("preserves bounded native failure diagnostics without changing the terminal code", async () => {
    const port = await createNativeEditableArtifactSubprocessPort(options());
    const normalizedOptions = '{"typedFailure":true}';
    await expect(
      port.materialize({
        job: makeJob({
          normalizedOptions,
          optionsHash: hash(new TextEncoder().encode(normalizedOptions)),
        }),
        normalizedOptions: new TextEncoder().encode(normalizedOptions),
        snapshot: chunks(source),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "source_identity_mismatch",
      diagnostic: { stage: "native", subcode: "state_mismatch" },
    });
  });

  test("large multi-chunk input reuses one abort/exit listener pair", async () => {
    const large = new Uint8Array(4 * 1024 * 1024);
    large.fill(7);
    const port = await createNativeEditableArtifactSubprocessPort({
      ...options(),
      maxSourceBytes: large.byteLength,
    });
    const abort = new AbortController();
    const result = await port.materialize({
      job: makeJob({ sourceByteSize: large.byteLength, sourceContentHash: hash(large) }),
      normalizedOptions: new TextEncoder().encode("{}"),
      snapshot: manyChunks(large, 1024),
      signal: abort.signal,
    });
    expect(getEventListeners(abort.signal, "abort").length).toBeLessThanOrEqual(2);
    await consume(result.chunks);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  test("rejects malformed or self-inconsistent output metadata", async () => {
    const port = await createNativeEditableArtifactSubprocessPort(options());
    for (const malformed of ["hash", "type", "extra", "mime", "codec"] as const) {
      const normalizedOptions = JSON.stringify({ malformed });
      await expect(
        port.materialize({
          job: makeJob({
            normalizedOptions,
            optionsHash: hash(new TextEncoder().encode(normalizedOptions)),
          }),
          normalizedOptions: new TextEncoder().encode(normalizedOptions),
          snapshot: chunks(source),
          signal: new AbortController().signal,
        }),
      ).rejects.toBeDefined();
    }
  });
});

function options() {
  return {
    executable,
    launcher: testLauncher(),
    wallTimeoutMs: 2_000,
    maxSourceBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
  } as const;
}

function testLauncher() {
  return Object.freeze({
    identity: Object.freeze({
      platform: "test-unenforced",
      isolation: "subprocess" as const,
      network: "denied" as const,
      officeAutomation: false as const,
      sandboxEnforced: true as const,
      memoryLimitBytes: 128 * 1024 * 1024,
      cpuTimeLimitMs: 10_000,
      fileDescriptorLimit: 64,
      processLimit: 64,
      fileSizeLimitBytes: 128 * 1024 * 1024,
    }),
    spawn(input: {
      executable: string;
      args: readonly string[];
      environment: Readonly<Record<string, string>>;
    }) {
      return spawn(input.executable, [...input.args], {
        cwd: "/",
        env: { ...input.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });
}

function makeJob(
  override: Partial<ClaimedEditableArtifactMaterialization> = {},
): ClaimedEditableArtifactMaterialization {
  return {
    scope: {
      accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
    artifactId: "11111111111111111111111111111111",
    jobId: "22222222222222222222222222222222",
    versionId: "33333333333333333333333333333333",
    modality: "spreadsheet",
    inputSnapshotId: "44444444444444444444444444444444",
    targetHeadSequence: 9,
    stateHash: hash(new TextEncoder().encode("state")),
    sourceObjectReference: "immutable:snapshot",
    sourceByteSize: source.byteLength,
    sourceContentHash: hash(source),
    sourceMimeType: "application/vnd.opengeni.artifact-snapshot",
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    snapshotProtocolVersion: 1,
    format: "xlsx",
    codecId: "opengeni.xlsx",
    normalizedOptions: "{}",
    optionsHash: hash(new TextEncoder().encode("{}")),
    codecVersion: "fixture-codec-1",
    kernelVersion: "fixture-kernel-1",
    fontRegistryHash: staticHash,
    policyHash: staticHash,
    attemptCount: 1,
    leaseOwner: "test-owner",
    leaseExpiresAt: "2026-08-08T12:00:00.000Z",
    ...override,
  };
}

async function* chunks(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes.slice(0, 4);
  yield bytes.slice(4);
}

async function* manyChunks(
  bytes: Uint8Array,
  chunkBytes: number,
): AsyncIterableIterator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    yield bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkBytes));
  }
}

async function consume(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  let length = 0;
  for await (const value of stream) {
    values.push(value);
    length += value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
