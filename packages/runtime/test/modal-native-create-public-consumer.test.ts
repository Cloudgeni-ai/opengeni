import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileNativeFreshCreate,
  describeNativeFreshCreate,
  type NativeFreshCreateCompilation,
  type NativeFreshCreatePreparation,
  type NativeFreshCreateSpec,
} from "@opengeni/runtime/sandbox";

// A package consumer supplies the entire known-ID recipe without any SDK,
// provider-private imports, credentials, mutable session or DB adapter.
function fixture(): NativeFreshCreateSpec {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const providerBinding = {
    version: 1 as const,
    serverUrl: "https://api.modal.com",
    workspaceName: "public-consumer",
    environment: "main",
  };
  return {
    version: 1,
    recipeId: "modal-native-fresh-v1",
    recipeRevision: 1,
    createWorkdir: "/tmp",
    entrypoint: ["sleep", "infinity"],
    origin: {
      version: 1,
      planId: id(8),
      creatorId: id(9),
      accountId: id(1),
      workspaceId: id(2),
      sessionId: id(3),
      turnId: id(4),
      attemptId: id(5),
      executionGeneration: 2,
      triggerEventId: id(6),
      sandboxGroupId: id(7),
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
      providerBinding,
      providerBindingKey: JSON.stringify(providerBinding),
    },
    blueprint: {
      version: 1,
      adapterId: "modal-native-fresh-creator-reservation-v1",
      create: {
        operationId: id(10),
        appId: "ap-known",
        imageId: "im-known",
        cpu: 0.333,
        memoryMiB: 512,
        timeoutSeconds: 300,
        env: {},
        mounts: [],
      },
      restore: null,
      readiness: {
        operationId: id(11),
        execId: id(12),
        commandArgs: ["/bin/true"],
        workdir: "/tmp",
        env: {},
      },
      publishOperationId: id(13),
      cleanup: { operationId: id(14), requires: "physical-terminal-proof" },
    },
  };
}

describe("native fresh-create supported package consumer", () => {
  test("public functions and types support synchronous pure compilation", () => {
    const spec: NativeFreshCreateSpec = fixture();
    const handle: NativeFreshCreatePreparation = compileNativeFreshCreate(spec);
    const compiled: NativeFreshCreateCompilation = describeNativeFreshCreate(handle);
    expect(typeof compileNativeFreshCreate).toBe("function");
    expect(typeof describeNativeFreshCreate).toBe("function");
    expect(handle).not.toBeInstanceOf(Promise);
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(compiled.spec).toEqual(spec);
    expect(compiled.spec).not.toBe(spec);
    expect(compiled.recipeId).toBe("modal-native-fresh-v1");
    expect(compiled.recipeRevision).toBe(1);
    expect(compiled.spec.blueprint.adapterId).toBe("modal-native-fresh-creator-reservation-v1");
    expect(compiled.normalizedRequest.definition.resources.milliCpu).toBe(333);
    expect(compiled.normalizedRequest.definition.entrypointArgs).toEqual(["sleep", "infinity"]);
    expect(compiled.normalizedRequest.definition.workdir).toBe("/tmp");
    expect(compiled.request.encoding).toBe("modal-create-json-v1");
    expect(compiled.requestJson).toBe(JSON.stringify(compiled.normalizedRequest));
    expect(compiled.request.sha256).toBe(
      createHash("sha256").update(compiled.requestJson).digest("hex"),
    );
    expect(compiled.request.byteLength).toBe(Buffer.byteLength(compiled.requestJson));
    expect(compiled.request.encoderFingerprint).toBe(compiled.compilerFingerprint);
  });

  test("public descriptor retains immutable data, not a transferable grant", () => {
    const spec = fixture();
    const handle = compileNativeFreshCreate(spec);
    const compiled = describeNativeFreshCreate(handle);
    spec.blueprint.create.cpu = 2;
    spec.origin.providerBinding.workspaceName = "successor";
    expect(describeNativeFreshCreate(handle)).toBe(compiled);
    expect(compiled.spec.blueprint.create.cpu).toBe(0.333);
    expect(compiled.spec.origin.providerBinding.workspaceName).toBe("public-consumer");
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.spec.origin.providerBinding)).toBe(true);
    expect(Object.isFrozen(compiled.normalizedRequest.definition.resources)).toBe(true);
    expect(() => describeNativeFreshCreate({ ...handle })).toThrow(
      "Unknown native fresh-create preparation",
    );
    expect(() => describeNativeFreshCreate(structuredClone(handle))).toThrow(
      "Unknown native fresh-create preparation",
    );
    expect(describeNativeFreshCreate(compileNativeFreshCreate(fixture()))).toEqual(compiled);
  });
});
