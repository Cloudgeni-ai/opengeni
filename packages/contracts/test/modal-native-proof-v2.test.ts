import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MODAL_NATIVE_PREPARATION_RECIPE_V2 as rootRecipe } from "@opengeni/contracts";
import {
  MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT,
  MODAL_NATIVE_FRESH_NORMALIZATION_V1,
  MODAL_NATIVE_PREPARATION_RECIPE_V2,
  ModalNativeFreshBlueprintV1,
  ModalNativeFreshNormalizationV1,
  ModalNativeNamespaceEvidenceV2,
  ModalNativeNamespaceReadClaimV2,
  ModalNativeOriginalCommandReadClaimV2,
  ModalNativeOriginalScopeV2,
  ModalNativePreparationDeclarationV2,
  ModalNativePreparationRecipeV2,
  ModalNativePreparedStartDescriptionV1,
} from "@opengeni/contracts/modal-native-proof-v2";
import { DelegatedAccessTokenPayload } from "../src/index";
import { ModalRouterProviderCommand } from "../src/sandbox-provider-command";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function declaration(): ModalNativePreparationDeclarationV2 {
  return {
    version: 2,
    scope: {
      version: 2,
      declarationId: id(20),
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
    preparationRecipe: structuredClone(MODAL_NATIVE_PREPARATION_RECIPE_V2),
    configurationCaptureRef: { id: id(21), revision: 1 },
    proofGrantRef: { id: id(22), epoch: 1 },
    providerRecoveryCount: 5,
    namespaceState: "unbound",
  };
}

function namespaceClaim(): ModalNativeNamespaceReadClaimV2 {
  const value = declaration();
  return {
    version: 2,
    scope: value.scope,
    configurationCaptureRef: value.configurationCaptureRef,
    proofGrantRef: value.proofGrantRef,
    claimId: id(23),
    nonce: id(24),
    claimRevision: 3,
    recordRevision: 4,
    captureId: id(25),
    expiresAt: "2026-10-04T04:00:00.000Z",
    purpose: "original-namespace-read",
    reservation: { id: id(26), epoch: 0 },
  };
}

function namespaceEvidence(): ModalNativeNamespaceEvidenceV2 {
  const { expiresAt: _expiresAt, ...claim } = namespaceClaim();
  return {
    ...claim,
    source: "modal-client-workspace-name-lookup-v1",
    responseField: "workspaceName",
    binding: {
      version: 1,
      serverUrl: "https://api.modal.com",
      workspaceName: "original",
      environment: "main",
    },
  };
}

function commandClaim(): ModalNativeOriginalCommandReadClaimV2 {
  return {
    ...namespaceClaim(),
    purpose: "original-readiness-read",
    physicalOwnerGeneration: 1,
    operationId: id(11),
    providerBindingKey: JSON.stringify(namespaceEvidence().binding),
    command: {
      kind: "modal-router-v1",
      sandboxId: "sb-original",
      taskId: "ta-original",
      execId: id(12),
      streams: {
        stdout: { byteOffset: 7, utf8Remainder: "4oI=", eof: false, exitCode: null },
        stderr: { byteOffset: 1, utf8Remainder: "", eof: true, exitCode: 17 },
      },
    },
  };
}

function startDescription(): ModalNativePreparedStartDescriptionV1 {
  return {
    taskId: "ta-original",
    execId: id(12),
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
  };
}

describe("Modal native V2 passive correlation contracts", () => {
  test.each(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-7aaa-baaa-aaaaaaaaaaaa"])(
    "readiness execId %s round-trips exactly through declaration, descriptor and original claim",
    (execId) => {
      const preparation = declaration();
      preparation.blueprint.readiness.execId = execId;
      const declared = ModalNativePreparationDeclarationV2.parse(preparation);
      const descriptor = ModalNativePreparedStartDescriptionV1.parse({
        ...startDescription(),
        execId,
      });
      const claim = commandClaim();
      claim.command.execId = descriptor.execId;
      const original = ModalNativeOriginalCommandReadClaimV2.parse(claim);
      expect(declared.blueprint.readiness.execId).toBe(execId);
      expect(descriptor.execId).toBe(execId);
      expect(original.command.execId).toBe(execId);
      expect(ModalRouterProviderCommand.parse(original.command).execId).toBe(execId);
    },
  );

  test.each([
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa",
  ])("readiness rejects UUIDs outside the compiler/command intersection %s", (execId) => {
    const preparation = declaration();
    preparation.blueprint.readiness.execId = execId;
    const claim = commandClaim();
    claim.command.execId = execId;
    expect(ModalNativePreparationDeclarationV2.safeParse(preparation).success).toBe(false);
    expect(ModalNativeFreshBlueprintV1.safeParse(preparation.blueprint).success).toBe(false);
    expect(
      ModalNativePreparedStartDescriptionV1.safeParse({ ...startDescription(), execId }).success,
    ).toBe(false);
    // Historical observation keeps its existing uppercase support. Only fresh
    // preparation is limited by the immutable compiler's lowercase domain.
    const retainedAcceptsUppercase = execId === execId.toUpperCase();
    expect(ModalNativeOriginalCommandReadClaimV2.safeParse(claim).success).toBe(
      retainedAcceptsUppercase,
    );
    expect(ModalRouterProviderCommand.safeParse(claim.command).success).toBe(
      retainedAcceptsUppercase,
    );
  });

  test("exports the complete immutable pre-prefix recipe through root and subpath", () => {
    expect(rootRecipe).toBe(MODAL_NATIVE_PREPARATION_RECIPE_V2);
    expect(ModalNativePreparationRecipeV2.parse(rootRecipe)).toEqual(rootRecipe);
    const text = JSON.stringify(MODAL_NATIVE_FRESH_NORMALIZATION_V1);
    expect(Buffer.byteLength(text)).toBe(853);
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      MODAL_NATIVE_FRESH_COMPILER_FINGERPRINT,
    );
    expect(Object.isFrozen(rootRecipe)).toBe(true);
    expect(Object.isFrozen(rootRecipe.normalization.network.outboundCidrs)).toBe(true);
    expect(Object.isFrozen(rootRecipe.normalization.gpuProto)).toBe(true);
    expect(() => {
      rootRecipe.normalization.network.access = "other" as never;
    }).toThrow();
  });

  test("parsing retains full accepted origin without inventing bound/elected fields", () => {
    const input = declaration();
    const parsed = ModalNativePreparationDeclarationV2.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.hasOwn(parsed.scope, "providerBinding")).toBe(false);
    expect(Object.hasOwn(parsed.scope, "leaseId")).toBe(false);
    expect(Object.hasOwn(parsed.scope, "initiatingHumanId")).toBe(false);
    expect(parsed.blueprint.version).toBe(1);
    expect(Object.hasOwn(parsed.blueprint, "createWorkdir")).toBe(false);
    expect(parsed.preparationRecipe.createWorkdir).toBe("/tmp");
  });

  test.each([0, 1, 2, 3, 4, 5] as const)("preserves recovery count %s without reset", (count) => {
    const input = declaration();
    input.providerRecoveryCount = count;
    expect(ModalNativePreparationDeclarationV2.parse(input).providerRecoveryCount).toBe(count);
  });

  test.each([-1, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsupported recovery count %s",
    (count) => {
      const input = { ...declaration(), providerRecoveryCount: count };
      expect(ModalNativePreparationDeclarationV2.safeParse(input).success).toBe(false);
    },
  );

  test("requires all origin fields, generation and explicit unbound version", () => {
    for (const key of Object.keys(declaration().scope)) {
      const scope = { ...declaration().scope } as Record<string, unknown>;
      delete scope[key];
      expect(ModalNativeOriginalScopeV2.safeParse(scope).success).toBe(false);
    }
    for (const mutation of [
      { version: 1 },
      { executionGeneration: 0 },
      { executionGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { routeEpoch: -1 },
      { routeKind: "target" },
      { routeTargetId: id(30) },
      { creatorId: declaration().scope.attemptId },
    ]) {
      expect(
        ModalNativeOriginalScopeV2.safeParse({ ...declaration().scope, ...mutation }).success,
      ).toBe(false);
    }
    expect(
      ModalNativePreparationDeclarationV2.safeParse({ ...declaration(), namespaceState: "bound" })
        .success,
    ).toBe(false);
  });

  test("rejects each duplicate among the seven supplied operation identities", () => {
    const mutate: Array<(v: ModalNativePreparationDeclarationV2) => void> = [
      (v) => {
        v.scope.creatorId = v.scope.planId;
      },
      (v) => {
        v.blueprint.create.operationId = v.scope.creatorId;
      },
      (v) => {
        v.blueprint.readiness.operationId = v.blueprint.create.operationId;
      },
      (v) => {
        v.blueprint.readiness.execId = v.blueprint.readiness.operationId;
      },
      (v) => {
        v.blueprint.publishOperationId = v.blueprint.readiness.execId;
      },
      (v) => {
        v.blueprint.cleanup.operationId = v.blueprint.publishOperationId;
      },
    ];
    for (const change of mutate) {
      const input = declaration();
      change(input);
      expect(ModalNativePreparationDeclarationV2.safeParse(input).success).toBe(false);
    }
  });

  test.each([0.0001, 0.0011, 0, -0, -1, 128.001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsupported CPU %s with no clamping",
    (cpu) => {
      const input = declaration().blueprint;
      input.create.cpu = cpu;
      expect(ModalNativeFreshBlueprintV1.safeParse(input).success).toBe(false);
    },
  );

  test.each([0.001, 0.333, 1, 128])("preserves exact millicore CPU %s", (cpu) => {
    const input = declaration().blueprint;
    input.create.cpu = cpu;
    expect(ModalNativeFreshBlueprintV1.parse(input).create.cpu).toBe(cpu);
  });

  test("requires known app/image IDs and supported fixed resources before lookup", () => {
    for (const mutation of [
      { appId: "configured-app-name" },
      { imageId: "image-builder" },
      { appId: `ap-${"a".repeat(201)}` },
      { imageId: `im-${"b".repeat(201)}` },
      { memoryMiB: 127 },
      { memoryMiB: 1_048_577 },
      { timeoutSeconds: 0 },
      { timeoutSeconds: 86_401 },
      { mounts: [{}] },
      { env: { TOKEN: "not-retained" } },
      { regions: ["us-east"] },
    ]) {
      const input = declaration().blueprint;
      Object.assign(input.create, mutation);
      expect(ModalNativeFreshBlueprintV1.safeParse(input).success).toBe(false);
    }
  });

  test("rejects omitted, arbitrary or presence-altered normalization, even with a matching self-hash", () => {
    for (const key of Object.keys(MODAL_NATIVE_FRESH_NORMALIZATION_V1)) {
      const input = structuredClone(MODAL_NATIVE_FRESH_NORMALIZATION_V1) as Record<string, unknown>;
      delete input[key];
      expect(ModalNativeFreshNormalizationV1.safeParse(input).success).toBe(false);
    }
    for (const mutation of [
      { idleTimeout: 0 },
      { gpu: null },
      { pty: false },
      { environmentVariables: {} },
      { createWorkdir: "/workspace" },
      { sdkVersion: "0.10.0" },
      { sdkSourceSha256: "c".repeat(64) },
      {
        network: {
          access: "BLOCKED",
          outboundCidrs: [],
          outboundDomains: [],
          inboundCidrs: [],
          i6pn: false,
        },
      },
    ]) {
      const input = { ...structuredClone(MODAL_NATIVE_FRESH_NORMALIZATION_V1), ...mutation };
      expect(ModalNativeFreshNormalizationV1.safeParse(input).success).toBe(false);
      expect(
        ModalNativePreparationRecipeV2.safeParse({
          ...rootRecipe,
          normalization: input,
          compilerFingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        }).success,
      ).toBe(false);
    }
  });

  test("keeps full wrapper explicit and cannot backfill from readiness workdir", () => {
    for (const key of [
      "version",
      "recipeId",
      "recipeRevision",
      "createWorkdir",
      "entrypoint",
      "normalization",
      "compilerFingerprint",
    ]) {
      const input = structuredClone(rootRecipe) as Record<string, unknown>;
      delete input[key];
      expect(ModalNativePreparationRecipeV2.safeParse(input).success).toBe(false);
    }
    expect(
      ModalNativePreparationRecipeV2.safeParse({ ...rootRecipe, entrypoint: ["/bin/true"] })
        .success,
    ).toBe(false);
    expect(ModalNativePreparationRecipeV2.safeParse({ ...rootRecipe, version: 2 }).success).toBe(
      false,
    );
  });

  test("rejects token, keyed equality, fabricated grant and binding extras at every public layer", () => {
    for (const field of [
      "tokenId",
      "tokenSecret",
      "environmentsEncryptionKey",
      "commitment",
      "jwt",
      "authorized",
      "issuerBrand",
    ]) {
      const input = declaration();
      expect(
        ModalNativePreparationDeclarationV2.safeParse({ ...input, [field]: "not-public" }).success,
      ).toBe(false);
      expect(
        ModalNativeOriginalScopeV2.safeParse({ ...input.scope, [field]: "not-public" }).success,
      ).toBe(false);
      expect(
        ModalNativePreparationDeclarationV2.safeParse({
          ...input,
          configurationCaptureRef: { ...input.configurationCaptureRef, [field]: "not-public" },
        }).success,
      ).toBe(false);
      expect(
        ModalNativePreparationDeclarationV2.safeParse({
          ...input,
          proofGrantRef: { ...input.proofGrantRef, [field]: "not-public" },
        }).success,
      ).toBe(false);
    }
    expect(
      ModalNativeOriginalScopeV2.safeParse({
        ...declaration().scope,
        providerBinding: namespaceEvidence().binding,
      }).success,
    ).toBe(false);
  });

  test("namespace claims carry only reservation exclusion, not an elected owner or task", () => {
    const value = namespaceClaim();
    expect(ModalNativeNamespaceReadClaimV2.parse(value)).toEqual(value);
    for (const extra of [
      { taskId: "ta-invented" },
      { execId: id(12) },
      { electedCreatorId: id(9) },
      { effectPermission: "Start" },
    ]) {
      expect(ModalNativeNamespaceReadClaimV2.safeParse({ ...value, ...extra }).success).toBe(false);
    }
    for (const key of [
      "nonce",
      "captureId",
      "claimRevision",
      "recordRevision",
      "expiresAt",
      "configurationCaptureRef",
      "proofGrantRef",
      "reservation",
    ]) {
      const input = { ...value } as Record<string, unknown>;
      delete input[key];
      expect(ModalNativeNamespaceReadClaimV2.safeParse(input).success).toBe(false);
    }
  });

  test.each(["workspaceName", "username"] as const)(
    "names the real native namespace response field %s without inventing a principal",
    (responseField) => {
      const evidence = { ...namespaceEvidence(), responseField };
      expect(ModalNativeNamespaceEvidenceV2.parse(evidence)).toEqual(evidence);
      expect(
        ModalNativeNamespaceEvidenceV2.safeParse({ ...evidence, providerPrincipalId: "invented" })
          .success,
      ).toBe(false);
      expect(
        ModalNativeNamespaceEvidenceV2.safeParse({ ...evidence, responseField: "principalId" })
          .success,
      ).toBe(false);
    },
  );

  test.each([
    "not-a-url",
    "http://api.modal.com",
    "https://secret:password@api.modal.com",
    "https://api.modal.com?token=not-public",
    "https://api.modal.com#not-public",
  ])("rejects unsafe endpoint %s without throwing from safeParse", (serverUrl) => {
    const input = namespaceEvidence();
    input.binding.serverUrl = serverUrl;
    expect(ModalNativeNamespaceEvidenceV2.safeParse(input).success).toBe(false);
  });

  test("namespace evidence retains exact claim key and forbids declaration/profile rewriting", () => {
    const input = namespaceEvidence();
    for (const key of [
      "nonce",
      "claimRevision",
      "recordRevision",
      "captureId",
      "purpose",
      "reservation",
    ]) {
      const missing = { ...input } as Record<string, unknown>;
      delete missing[key];
      expect(ModalNativeNamespaceEvidenceV2.safeParse(missing).success).toBe(false);
    }
    for (const extra of [
      { preparationRecipe: rootRecipe },
      { credentials: "not-public" },
      { expiresAt: namespaceClaim().expiresAt },
    ]) {
      expect(ModalNativeNamespaceEvidenceV2.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });

  test("preserves asymmetric nonempty raw cursors, partial UTF-8 and nonzero terminal data without promoting it to completion", () => {
    const input = commandClaim();
    expect(ModalNativeOriginalCommandReadClaimV2.parse(input)).toEqual(input);
    expect(input.command.streams.stdout.eof).toBe(false);
    expect(input.command.streams.stderr.exitCode).toBe(17);
    expect(Object.hasOwn(input, "completed")).toBe(false);
    const parsed = ModalNativeOriginalCommandReadClaimV2.parse(input);
    input.command.streams.stdout.byteOffset = 99;
    expect(parsed.command.streams.stdout.byteOffset).toBe(7);
  });

  test("rejects legacy retargeting, PTY, premature exit and mutating proof purposes", () => {
    const input = commandClaim();
    for (const purpose of [
      "Start",
      "stdin",
      "Create",
      "process-cancel",
      "original-namespace-read",
    ]) {
      expect(ModalNativeOriginalCommandReadClaimV2.safeParse({ ...input, purpose }).success).toBe(
        false,
      );
    }
    for (const command of [
      { ...input.command, kind: "modal-control-v1" },
      { ...input.command, pty: true },
      { ...input.command, taskId: "" },
      {
        ...input.command,
        streams: {
          ...input.command.streams,
          stdout: { ...input.command.streams.stdout, exitCode: 0 },
        },
      },
    ]) {
      expect(ModalNativeOriginalCommandReadClaimV2.safeParse({ ...input, command }).success).toBe(
        false,
      );
    }
  });

  test("keeps preflight hash/fingerprint/encoder and RPC domains distinct", () => {
    const input = startDescription();
    expect(ModalNativePreparedStartDescriptionV1.parse(input)).toEqual(input);
    for (const preflight of [
      { ...input.preflight, sha256: `sha256:${"a".repeat(64)}` },
      { ...input.preflight, encoderFingerprint: "b".repeat(64) },
      { ...input.preflight, encoding: "modal-create-json-v1" },
      { ...input.preflight, byteLength: 0 },
      { ...input.preflight, byteLength: 1_048_577 },
    ]) {
      expect(ModalNativePreparedStartDescriptionV1.safeParse({ ...input, preflight }).success).toBe(
        false,
      );
    }
    expect(
      ModalNativePreparedStartDescriptionV1.safeParse({ ...input, transmitted: true }).success,
    ).toBe(false);
    expect(
      ModalNativePreparedStartDescriptionV1.safeParse({
        ...input,
        encoderVersion: "protobufjs@8.0.0",
      }).success,
    ).toBe(false);
    expect(
      ModalNativePreparedStartDescriptionV1.safeParse({ ...input, rpcMethod: "Create" }).success,
    ).toBe(false);
  });

  test("does not weaken ordinary delegation to invent a worker-host proof authority", () => {
    const base = {
      accountId: id(1),
      workspaceId: id(2),
      subjectId: "service:worker-host",
      permissions: ["workspace:read"],
      exp: 4_102_444_800,
      sessionId: id(3),
      turnId: id(4),
      attemptId: id(5),
      executionGeneration: 2,
    };
    expect(
      DelegatedAccessTokenPayload.safeParse({ ...base, principalKind: "service" }).success,
    ).toBe(false);
    expect(
      DelegatedAccessTokenPayload.safeParse({ ...base, principalKind: "agent_attempt" }).success,
    ).toBe(true);
    expect(
      ModalNativeNamespaceReadClaimV2.safeParse({ ...namespaceClaim(), delegatedAccessToken: base })
        .success,
    ).toBe(false);
  });
});
