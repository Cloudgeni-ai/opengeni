import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT,
  MODAL_NATIVE_FRESH_NORMALIZATION_V1,
  MODAL_NATIVE_PREPARATION_RECIPE_V2,
  ModalNativePreparationDeclarationV2,
  ModalNativeFreshBlueprintV1,
  ModalNativeOriginalCommandReadClaimV2,
  ModalNativePreparedStartDescriptionV1,
} from "@opengeni/contracts/modal-native-proof-v2";
import {
  compileNativeFreshCreate,
  describeNativeFreshCreate,
  type NativeFreshCreateSpec,
} from "@opengeni/runtime/sandbox";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// This synthetic bound test fixture exercises PURE data compilation only. No
// production declaration, native client, provider lookup or grant is issued.
function fixture(): NativeFreshCreateSpec {
  const providerBinding = {
    version: 1 as const,
    serverUrl: "https://api.modal.com",
    workspaceName: "pure-fixture",
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

describe("host pre-prefix literal versus unchanged public native compiler", () => {
  test.each(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-7aaa-baaa-aaaaaaaaaaaa"])(
    "accepted readiness %s survives actual pure compilation and original-command correlation",
    (execId) => {
      const spec = fixture();
      spec.blueprint.readiness.execId = execId;
      const {
        version: _version,
        providerBinding: _binding,
        providerBindingKey: _key,
        ...unbound
      } = spec.origin;
      const declared = ModalNativePreparationDeclarationV2.parse({
        version: 2,
        scope: { ...unbound, version: 2, declarationId: id(20) },
        blueprint: spec.blueprint,
        preparationRecipe: MODAL_NATIVE_PREPARATION_RECIPE_V2,
        configurationCaptureRef: { id: id(21), revision: 1 },
        proofGrantRef: { id: id(22), epoch: 1 },
        providerRecoveryCount: 5,
        namespaceState: "unbound",
      });
      const compiled = describeNativeFreshCreate(
        compileNativeFreshCreate({ ...spec, blueprint: declared.blueprint }),
      );
      const descriptor = ModalNativePreparedStartDescriptionV1.parse({
        taskId: "ta-pure-fixture",
        execId: compiled.spec.blueprint.readiness.execId,
        descriptorProtocol: "modal-prepared-start-descriptor",
        descriptorVersion: 1,
        readinessRecipe: "modal-exec-readiness-bin-true-v1",
        readinessRecipeVersion: 1,
        startMessage: "Start",
        rpcMethod: "/modal.task_command_router.TaskCommandRouter/TaskExecStart",
        encoderVersion: "protobufjs@7.6.5",
        preflight: {
          encoding: "modal-start-protobuf-preflight-v1",
          sha256: "a".repeat(64),
          byteLength: 100,
          encoderFingerprint: `sha256:${"b".repeat(64)}`,
        },
      });
      const original = ModalNativeOriginalCommandReadClaimV2.parse({
        version: 2,
        scope: declared.scope,
        configurationCaptureRef: declared.configurationCaptureRef,
        proofGrantRef: declared.proofGrantRef,
        claimId: id(23),
        nonce: id(24),
        claimRevision: 3,
        recordRevision: 4,
        captureId: id(25),
        expiresAt: "2026-10-04T04:00:00.000Z",
        purpose: "original-readiness-read",
        reservation: { id: id(26), epoch: 0 },
        physicalOwnerGeneration: 1,
        operationId: declared.blueprint.readiness.operationId,
        providerBindingKey: spec.origin.providerBindingKey,
        command: {
          kind: "modal-router-v1",
          sandboxId: "sb-pure-fixture",
          taskId: descriptor.taskId,
          execId: descriptor.execId,
          streams: {
            stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
            stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          },
        },
      });
      expect(compiled.spec.blueprint.readiness.execId).toBe(execId);
      expect(descriptor.execId).toBe(execId);
      expect(original.command.execId).toBe(execId);
      expect(declared.providerRecoveryCount).toBe(5);
    },
  );

  test("fresh blueprints do not admit uppercase command IDs rejected by the unchanged compiler", () => {
    const spec = fixture();
    spec.blueprint.readiness.execId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(() => compileNativeFreshCreate(spec)).toThrow();
    expect(ModalNativeFreshBlueprintV1.safeParse(spec.blueprint).success).toBe(false);
  });

  test("retains the full pinned normalization, exact serialization and fingerprint domain", () => {
    const compiled = describeNativeFreshCreate(compileNativeFreshCreate(fixture()));
    const host = MODAL_NATIVE_PREPARATION_RECIPE_V2;
    expect(compiled.normalization).toEqual(host.normalization);
    expect(JSON.stringify(compiled.normalization)).toBe(JSON.stringify(host.normalization));
    expect(compiled.compilerFingerprint).toBe(host.compilerFingerprint);
    expect(createHash("sha256").update(JSON.stringify(host.normalization)).digest("hex")).toBe(
      MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT,
    );
    expect(Buffer.byteLength(JSON.stringify(host.normalization))).toBe(853);
    expect(compiled.recipeId).toBe(host.recipeId);
    expect(compiled.recipeRevision).toBe(host.recipeRevision);
    expect(compiled.spec.entrypoint).toEqual(host.entrypoint);
    expect(compiled.spec.createWorkdir).toBe(host.createWorkdir);
    expect(compiled.request.encoderFingerprint).toBe(host.compilerFingerprint);
    expect(compiled.request.encoding).toBe(host.normalization.encoding);
  });

  test("the prebinding header is distinct from compiler-origin v1 and preserves its entire vocabulary", () => {
    const spec = fixture();
    const {
      version: _version,
      providerBinding: _binding,
      providerBindingKey: _key,
      ...unbound
    } = spec.origin;
    const header = ModalNativePreparationDeclarationV2.parse({
      version: 2,
      scope: { ...unbound, version: 2, declarationId: id(20) },
      blueprint: spec.blueprint,
      preparationRecipe: MODAL_NATIVE_PREPARATION_RECIPE_V2,
      configurationCaptureRef: { id: id(21), revision: 1 },
      proofGrantRef: { id: id(22), epoch: 1 },
      providerRecoveryCount: 5,
      namespaceState: "unbound",
    });
    const { version: _headerVersion, declarationId: _declarationId, ...retained } = header.scope;
    expect(retained).toEqual(unbound);
    expect(header.blueprint).toEqual(spec.blueprint);
    expect(header.scope.version).toBe(2);
    expect(spec.origin.version).toBe(1);
    expect(() => compileNativeFreshCreate({ ...spec, origin: header.scope } as never)).toThrow();
    expect(Object.hasOwn(header.blueprint, "createWorkdir")).toBe(false);
  });

  test("unset own properties are not falsely represented as losslessly persisted JSONB", () => {
    const compiled = describeNativeFreshCreate(compileNativeFreshCreate(fixture()));
    expect(Object.hasOwn(compiled.normalizedRequest.definition, "idleTimeoutSecs")).toBe(true);
    expect(compiled.normalizedRequest.definition.idleTimeoutSecs).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(compiled.requestJson).definition, "idleTimeoutSecs")).toBe(
      false,
    );
    expect(MODAL_NATIVE_FRESH_NORMALIZATION_V1.idleTimeout).toBe("unset");
    expect(compiled.requestJson).toBe(JSON.stringify(compiled.normalizedRequest));
    expect(compiled.normalizedRequest.environmentName).toBe("");
    expect(compiled.spec.origin.providerBinding.environment).toBe("main");
    expect(createHash("sha256").update(compiled.requestJson).digest("hex")).toBe(
      compiled.request.sha256,
    );
    expect(Buffer.byteLength(compiled.requestJson)).toBe(compiled.request.byteLength);
  });
});
