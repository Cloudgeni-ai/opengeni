import { describe, expect, test } from "bun:test";
import {
  causalFrontierDominates,
  causalFrontiersEqual,
  compareCodeUnits,
  assertBoundedKernelVersion,
  editableArtifactCausalFrontier,
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactActorKey,
  assertIsoTimestamp,
  mergeCausalFrontiers,
} from "../../src/domain/editable-artifacts/types";
import {
  artifactFixture,
  artifactId,
  humanActor,
  scope,
  stableHex,
  transactionRequest,
} from "./fixtures";

describe("editable artifact stable identity and causality", () => {
  test("accepts fixed-width stable ids and rejects ambiguous encodings", () => {
    expect(String(editableArtifactId(stableHex(1, 2)))).toBe(stableHex(1, 2));
    expect(() => editableArtifactId("0".repeat(32))).toThrow("nonzero");
    expect(() => editableArtifactId("A".repeat(32))).toThrow("lowercase");
    expect(() => editableArtifactId("1".repeat(31))).toThrow("fixed-width");
    expect(() => editableArtifactReplicaId("0".repeat(16))).toThrow("nonzero");
    expect(() => editableArtifactClientTransactionId("contains space")).toThrow("portable");
  });

  test("normalizes frontiers by locale-independent replica order", () => {
    const replicaA = editableArtifactReplicaId("a000000000000000");
    const replicaNine = editableArtifactReplicaId("9000000000000000");
    const frontier = editableArtifactCausalFrontier([
      { replicaId: replicaA, counter: 2 },
      { replicaId: replicaNine, counter: 3 },
    ]);
    expect(frontier.map((entry) => entry.replicaId)).toEqual([replicaNine, replicaA]);
    expect(compareCodeUnits("Z", "a")).toBe(-1);
    expect(Object.isFrozen(frontier)).toBe(true);
    expect(Object.isFrozen(frontier[0]!)).toBe(true);
    expect(() =>
      editableArtifactCausalFrontier([
        { replicaId: replicaA, counter: 1 },
        { replicaId: replicaA, counter: 2 },
      ]),
    ).toThrow("duplicate causal replica");
    expect(() => editableArtifactCausalFrontier([{ replicaId: replicaA, counter: 0 }])).toThrow(
      "positive safe integer",
    );
  });

  test("keeps delivery order and semantic causality as distinct dimensions", () => {
    const a = editableArtifactReplicaId("0000000000000001");
    const b = editableArtifactReplicaId("0000000000000002");
    const first = editableArtifactCausalFrontier([{ replicaId: a, counter: 5 }]);
    const second = editableArtifactCausalFrontier([{ replicaId: b, counter: 2 }]);
    const merged = mergeCausalFrontiers(first, second);
    expect(causalFrontierDominates(merged, first)).toBe(true);
    expect(causalFrontierDominates(first, merged)).toBe(false);
    expect(
      causalFrontiersEqual(merged, editableArtifactCausalFrontier([...second, ...first])),
    ).toBe(true);
    // A server head sequence cannot be derived from either replica counter.
    expect(merged).toEqual([
      { replicaId: a, counter: 5 },
      { replicaId: b, counter: 2 },
    ]);
  });

  test("rejects syntactically canonical but impossible timestamps", () => {
    expect(() => assertIsoTimestamp("2026-02-29T10:00:00.000Z", "timestamp")).toThrow(
      "canonical UTC",
    );
    expect(() => assertIsoTimestamp("2026-08-08T10:00:00.000Z", "timestamp")).not.toThrow();
  });

  test("shares the native kernel build-identity budget", () => {
    expect(() => assertBoundedKernelVersion("k".repeat(512))).not.toThrow();
    expect(() => assertBoundedKernelVersion("k".repeat(513))).toThrow("1-512");
    expect(() => assertBoundedKernelVersion("😀".repeat(129))).toThrow("1-512");
    expect(() => assertBoundedKernelVersion("kernel\ud800")).toThrow("well-formed");
  });

  test("rejects unknown, mixed, inherited, and accessor actor authorities", () => {
    expect(() =>
      editableArtifactActorKey({
        kind: "unknown",
        subjectId: "subject",
        replicaId: "1111111111111111",
      } as never),
    ).toThrow("kind is invalid");
    expect(() => editableArtifactActorKey({ ...humanActor, service: "smuggled" } as never)).toThrow(
      "missing or unknown",
    );
    expect(() =>
      editableArtifactActorKey(
        Object.create(
          { kind: "human" },
          {
            subjectId: { value: "subject", enumerable: true },
            replicaId: { value: "1111111111111111", enumerable: true },
          },
        ) as never,
      ),
    ).toThrow("plain data object");
    let called = false;
    const actor = {
      kind: "human",
      replicaId: "1111111111111111",
    } as Record<string, unknown>;
    Object.defineProperty(actor, "subjectId", {
      enumerable: true,
      get() {
        called = true;
        return "subject";
      },
    });
    expect(() => editableArtifactActorKey(actor as never)).toThrow("must be own data");
    expect(called).toBe(false);
  });
});

describe("editable artifact canonical intent boundary", () => {
  test("retries the same exact intent bytes and hash", async () => {
    const { service } = await artifactFixture();
    const commandBytes = new TextEncoder().encode(JSON.stringify([{ code: "cell.set", value: 1 }]));
    const left = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-stable"),
      commandBytes,
    });
    const right = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-stable"),
      commandBytes,
    });
    expect([...left.intentBytes]).toEqual([...right.intentBytes]);
    expect(left.requestHash).toBe(right.requestHash);
  });

  test("binds the authoring replica inside canonical intent bytes", async () => {
    const { service } = await artifactFixture();
    const clientTransactionId = editableArtifactClientTransactionId("client-replica-bound");
    const first = await transactionRequest(service, {
      clientTransactionId,
    });
    const second = await transactionRequest(service, {
      clientTransactionId,
      actor: {
        ...humanActor,
        replicaId: editableArtifactReplicaId("000000000000000f"),
      },
    });
    expect(first.requestHash).not.toBe(second.requestHash);
  });

  test("rejects envelope accessors without evaluating them", async () => {
    const { service } = await artifactFixture();
    const valid = await transactionRequest(service);
    let getterCalled = false;
    const accessor = { requestHash: valid.requestHash } as Record<string, unknown>;
    Object.defineProperty(accessor, "intentBytes", {
      enumerable: true,
      get() {
        getterCalled = true;
        return valid.intentBytes;
      },
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: accessor as never,
      }),
    ).rejects.toThrow("Accessor property");
    expect(getterCalled).toBe(false);
  });
});
