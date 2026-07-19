import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  buildRecoveryArtifact,
  canonicalJson,
  recordRecoveryArtifactPersistenceRetry,
  RecoveryArtifactValidationError,
  sha256Canonical,
  type RecoveryArtifactBuildInput,
  type RecoveryArtifactObservability,
} from "../src/index";

const WORKSPACE_ID = "10000000-0000-0000-0000-000000000001";
const ROOT_ID = "20000000-0000-0000-0000-000000000001";
const CHILD_A_ID = "20000000-0000-0000-0000-000000000002";
const CHILD_B_ID = "20000000-0000-0000-0000-000000000003";

function input(): RecoveryArtifactBuildInput {
  return {
    workspaceId: WORKSPACE_ID,
    rootSessionId: ROOT_ID,
    workspaceControlRevision: "17",
    partitionSize: 2,
    sessions: [
      {
        sessionId: CHILD_B_ID,
        parentSessionId: ROOT_ID,
        recoveryRevision: "9",
        state: {
          id: CHILD_B_ID,
          title: "never-retained-title",
          updated_at: "2026-07-19T12:34:56.000+00:00",
          metadata: { z: true, a: 1 },
        },
      },
      {
        sessionId: ROOT_ID,
        parentSessionId: null,
        recoveryRevision: "4",
        state: {
          metadata: {},
          id: ROOT_ID,
          updated_at: "2026-07-19T12:00:00.000+00:00",
        },
      },
      {
        sessionId: CHILD_A_ID,
        parentSessionId: ROOT_ID,
        recoveryRevision: "6",
        state: {
          updated_at: "2026-07-19T12:12:00.000+00:00",
          id: CHILD_A_ID,
          metadata: { nested: [3, 2, 1] },
        },
      },
    ],
    events: [
      {
        sessionId: CHILD_A_ID,
        event: {
          sequence: 2,
          id: "30000000-0000-0000-0000-000000000003",
          payload: { token: "secret-event-payload", answer: 42 },
          type: "agent.model.usage",
        },
      },
      {
        sessionId: ROOT_ID,
        event: {
          sequence: 1,
          id: "30000000-0000-0000-0000-000000000001",
          type: "session.created",
          payload: { hello: "world" },
        },
      },
      {
        sessionId: CHILD_A_ID,
        event: {
          sequence: 1,
          id: "30000000-0000-0000-0000-000000000002",
          payload: { b: 2, a: 1 },
          type: "agent.output",
        },
      },
    ],
  };
}

function reversedInput(value: RecoveryArtifactBuildInput): RecoveryArtifactBuildInput {
  return {
    ...value,
    sessions: [...value.sessions].reverse(),
    events: [...value.events].reverse(),
  };
}

describe("canonical recovery artifacts", () => {
  test("canonical JSON normalizes keys, dates, bigint, and negative zero", () => {
    expect(
      canonicalJson({
        z: -0,
        a: new Date("2026-07-19T12:00:00Z"),
        n: 12n,
        nested: { beta: true, alpha: null },
      }),
    ).toBe('{"a":"2026-07-19T12:00:00.000Z","n":"12","nested":{"alpha":null,"beta":true},"z":0}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
  });

  test("canonical JSON rejects lossy or process-specific values", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(RecoveryArtifactValidationError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(RecoveryArtifactValidationError);
    expect(() => canonicalJson({ omitted: undefined })).toThrow(RecoveryArtifactValidationError);
    expect(() => canonicalJson(Symbol("not-json"))).toThrow(RecoveryArtifactValidationError);
  });

  test("shuffled inputs and retries produce identical manifests and partitions", () => {
    const original = buildRecoveryArtifact(input());
    const shuffled = buildRecoveryArtifact(reversedInput(input()));
    const retried = buildRecoveryArtifact(input());

    expect(shuffled).toEqual(original);
    expect(retried).toEqual(original);
    expect(original.manifest.sessions.map((session) => session.sessionId)).toEqual([
      ROOT_ID,
      CHILD_A_ID,
      CHILD_B_ID,
    ]);
    expect(original.manifest.partitions.map((partition) => partition.sessionCount)).toEqual([2, 1]);
    expect(original.manifest.partitions.map((partition) => partition.eventCount)).toEqual([3, 0]);

    const serialized = JSON.stringify(original.manifest);
    expect(serialized).not.toContain("never-retained-title");
    expect(serialized).not.toContain("secret-event-payload");
  });

  test("an independent process produces the same checksum", async () => {
    const expected = buildRecoveryArtifact(input());
    const script = fileURLToPath(
      new URL("./fixtures/recovery-artifact-process.ts", import.meta.url),
    );
    const child = Bun.spawn([process.execPath, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(input()));
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      artifactHash: expected.artifactHash,
      partitionHashes: expected.manifest.partitions.map((partition) => partition.partitionHash),
    });
  });

  test("duplicate sessions and duplicate event sequences are rejected", () => {
    const duplicateSession = input();
    duplicateSession.sessions = [...duplicateSession.sessions, [...duplicateSession.sessions][0]!];
    expect(() => buildRecoveryArtifact(duplicateSession)).toThrow(/strict canonical order/);

    const duplicateSequence = input();
    duplicateSequence.events = [
      ...duplicateSequence.events,
      {
        sessionId: CHILD_A_ID,
        event: {
          sequence: 2,
          id: "30000000-0000-0000-0000-000000000004",
          type: "duplicate",
        },
      },
    ];
    expect(() => buildRecoveryArtifact(duplicateSequence)).toThrow(/strict sequence order/);
  });

  test("retry telemetry exposes only fixed-cardinality phase and reason labels", () => {
    const calls: unknown[] = [];
    const observability: RecoveryArtifactObservability = {
      incrementCounter: (value) => calls.push(value),
      observeHistogram: (value) => calls.push(value),
    };
    recordRecoveryArtifactPersistenceRetry(observability, "admit", "serialization");
    expect(calls).toEqual([
      {
        name: "opengeni_recovery_artifact_persistence_retries_total",
        help: "Persistence-only retries while storing or admitting recovery artifacts.",
        labels: { phase: "admit", reason: "serialization" },
      },
    ]);
  });
});
