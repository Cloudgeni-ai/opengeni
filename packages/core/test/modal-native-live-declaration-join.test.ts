import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Database, ModalNativeLiveOriginProjection } from "@opengeni/db";
import {
  ModalNativePreparationDeclarationV2,
  MODAL_NATIVE_PREPARATION_RECIPE_V2,
} from "@opengeni/contracts/modal-native-proof-v2";
import { lockNativeLiveDeclarationJoinTx } from "../src/application/modal-native-live-declaration-join";
import {
  disposeNativeOriginalConfigurationSample,
  nativeOriginalConfigurationSnapshot,
  privateNativeOriginalConfigurationDraft,
} from "../src/application/modal-native-original-configuration";
import {
  configuredNativeWorkerHostTransport,
  disposeNativeWorkerHostTransport,
  signNativeWorkerHostTransport,
} from "../src/application/modal-native-worker-host-transport";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(count = 5) {
  const settings = {
    delegationSecret: "synthetic-explicit-deployment-root",
    modalTokenId: "synthetic-id",
    modalTokenSecret: "synthetic-secret",
    modalEnvironment: "",
    environmentsEncryptionKey: Buffer.alloc(32, 0x42).toString("base64"),
  };
  const declaration = ModalNativePreparationDeclarationV2.parse({
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
    preparationRecipe: MODAL_NATIVE_PREPARATION_RECIPE_V2,
    configurationCaptureRef: { id: id(21), revision: 1 },
    proofGrantRef: { id: id(22), epoch: 1 },
    providerRecoveryCount: count,
    namespaceState: "unbound",
  });
  const request = {
    protocol: "opengeni-modal-native-live-declaration-join",
    version: 2,
    requestId: id(23),
    workflowId: "workflow-original",
    workflowRunId: "run-original",
    activityId: "activity-original",
    initiatingHumanSubjectId: "user:original",
    declarationJson: JSON.stringify(declaration),
  };
  const intent = {
    protocol: "opengeni-modal-native-worker-host-proof" as const,
    version: 2 as const,
    principalKind: "worker_host" as const,
    purpose: "original-native-custody-proof" as const,
    action: "declare_preparation" as const,
    scope: declaration.scope,
    configurationCaptureRef: declaration.configurationCaptureRef,
    proofGrantRef: declaration.proofGrantRef,
    requestId: request.requestId,
  };
  const projection: ModalNativeLiveOriginProjection = {
    version: 1,
    scope: declaration.scope,
    initiator: {
      kind: "subject",
      subjectId: "user:original",
      initiatingHumanSubjectId: "user:original",
    },
    membership: { id: id(30), authorizationRevision: "1", basis: "workspace_membership" },
    acceptedAuthority: {
      epoch: 1,
      visibility: "workspace_shared",
      ownerOrganizationMembershipId: null,
    },
    currentAuthority: {
      epoch: 1,
      executionEpoch: 1,
      visibility: "workspace_shared",
      ownerSubjectId: null,
      ownerOrganizationMembershipId: null,
    },
    control: { workspaceRevision: "1", sessionVersion: "1" },
    execution: {
      workflowId: request.workflowId,
      workflowRunId: request.workflowRunId,
      activityId: request.activityId,
    },
    providerRecoveryCount: count as ModalNativeLiveOriginProjection["providerRecoveryCount"],
    checkedAt: new Date().toISOString(),
  };
  function sign(body: Uint8Array, override = intent) {
    const transport = configuredNativeWorkerHostTransport(settings)!;
    try {
      return signNativeWorkerHostTransport(transport, override, body);
    } finally {
      disposeNativeWorkerHostTransport(transport);
    }
  }
  const body = Buffer.from(JSON.stringify(request));
  const envelope = sign(body);
  const execute = mock(async () => [{ result: { kind: "live", projection } }]);
  const tx = { rollback() {}, execute } as unknown as Database;
  return { settings, declaration, request, intent, projection, body, envelope, sign, execute, tx };
}

describe("unused private signed-request/live-origin DATA join, not custody authorization", () => {
  test.each([0, 1, 2, 3, 4, 5])(
    "preserves exact original IDs and count %s without minting any effect",
    async (count) => {
      const f = fixture(count);
      const result = await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body);
      expect(result.kind).toBe("joined_data");
      if (result.kind !== "joined_data") throw new Error("expected data join");
      expect(result.data.projection).toEqual(f.projection);
      expect(result.data.projection).not.toBe(f.projection);
      expect(result.data.declaration).toEqual(f.declaration);
      expect(result.data.declaration.providerRecoveryCount).toBe(count);
      expect(result.data.requestId).toBe(f.request.requestId);
      expect(nativeOriginalConfigurationSnapshot(result.data.configuration)?.environment).toBe("");
      expect(
        privateNativeOriginalConfigurationDraft(result.data.configuration)?.description
          .declarationJson,
      ).toBe(f.request.declarationJson);
      expect(Object.keys(result.data).sort()).toEqual([
        "configuration",
        "declaration",
        "projection",
        "requestId",
      ]);
      expect(f.execute).toHaveBeenCalledTimes(1);
      disposeNativeOriginalConfigurationSample(result.data.configuration);
    },
  );

  test("incoming bytes and signed fields cannot change while the SQL join waits", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      f.body.fill(0);
      f.request.initiatingHumanSubjectId = "user:changed";
      return [{ result: { kind: "live", projection: f.projection } }];
    });
    const result = await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body);
    expect(result.kind).toBe("joined_data");
    if (result.kind !== "joined_data") throw new Error("expected original owned bytes");
    expect(result.data.projection.initiator.initiatingHumanSubjectId).toBe("user:original");
    f.projection.initiator.initiatingHumanSubjectId = "user:changed-after-return";
    expect(result.data.projection.initiator.initiatingHumanSubjectId).toBe("user:original");
    expect(Object.isFrozen(result.data.declaration.scope)).toBe(true);
    expect(Object.isFrozen(result.data.declaration.blueprint.readiness)).toBe(true);
    expect(Object.isFrozen(result.data.projection.execution)).toBe(true);
    disposeNativeOriginalConfigurationSample(result.data.configuration);
  });

  test("expiry that passes initial MAC validation is rechecked after a blocking SQL join", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const f = fixture();
      f.execute.mockImplementation(async () => {
        now += 61_000;
        return [{ result: { kind: "live", projection: f.projection } }];
      });
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body)).toEqual({
        kind: "refused",
      });
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    "delegationSecret",
    "modalTokenId",
    "modalTokenSecret",
    "modalEnvironment",
    "environmentsEncryptionKey",
  ])(
    "current %s mismatch during SQL wait refuses the old snapshot, not a replacement lookup",
    async (key) => {
      const f = fixture();
      f.execute.mockImplementation(async () => {
        f.settings[key as keyof typeof f.settings] += "changed";
        return [{ result: { kind: "live", projection: f.projection } }];
      });
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body)).toEqual({
        kind: "refused",
      });
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["workflowId", "workflowRunId", "activityId"])(
    "exact original %s is source-joined, never adopted",
    async (key) => {
      const f = fixture();
      f.projection.execution[key as keyof typeof f.projection.execution] = "successor";
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body)).toEqual({
        kind: "refused",
      });
    },
  );

  test("source human, original scope and recovery count must all match without coercion or reset", async () => {
    for (const mutate of [
      (p: ModalNativeLiveOriginProjection) => {
        p.initiator.initiatingHumanSubjectId = "user:successor";
      },
      (p: ModalNativeLiveOriginProjection) => {
        (p as { scope: typeof p.scope }).scope = { ...p.scope, attemptId: id(90) };
      },
      (p: ModalNativeLiveOriginProjection) => {
        p.providerRecoveryCount = 0;
      },
    ]) {
      const f = fixture();
      mutate(f.projection);
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body)).toEqual({
        kind: "refused",
      });
    }
  });

  test("a valid MAC for another body/action/ref cannot reach SQL", async () => {
    const f = fixture();
    for (const envelope of [
      f.sign(Buffer.from("{}")),
      f.sign(f.body, { ...f.intent, scope: { ...f.intent.scope, attemptId: id(90) } }),
      f.sign(f.body, { ...f.intent, requestId: id(90) }),
      f.sign(f.body, { ...f.intent, configurationCaptureRef: { id: id(90), revision: 1 } }),
      f.sign(f.body, { ...f.intent, proofGrantRef: { id: id(90), epoch: 1 } }),
      "ordinary-agent-token",
    ])
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, envelope, f.body)).toEqual({
        kind: "refused",
      });
    const transport = configuredNativeWorkerHostTransport(f.settings)!;
    const actionEnvelope = signNativeWorkerHostTransport(
      transport,
      { ...f.intent, action: "claim_namespace_read", recordRevision: 1 },
      f.body,
    );
    disposeNativeWorkerHostTransport(transport);
    expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, actionEnvelope, f.body)).toEqual(
      { kind: "refused" },
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("absent explicit roots/pair/environment is OFF before SQL or provider prefix", async () => {
    for (const key of Object.keys(fixture().settings)) {
      const f = fixture();
      delete (f.settings as Partial<typeof f.settings>)[key as keyof typeof f.settings];
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body)).toEqual({
        kind: "off",
      });
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  test("proxy/shared/detached body input cannot execute traps or mint a data join", async () => {
    const f = fixture();
    const trap = mock(() => {
      throw new Error("must not execute");
    });
    const proxy = new Proxy(f.body, { get: trap, ownKeys: trap });
    const detached = new Uint8Array([1]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const body of [proxy, new Uint8Array(new SharedArrayBuffer(1)), detached])
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, body)).toEqual({
        kind: "refused",
      });
    expect(trap).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("own byte-view getter overrides are ignored without execution, using the actual backing bytes", async () => {
    const f = fixture();
    const body = Buffer.from(f.body);
    const getter = mock(() => {
      throw new Error("must not execute");
    });
    for (const key of ["byteLength", "byteOffset", "buffer"])
      Object.defineProperty(body, key, { get: getter });
    const result = await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, body);
    expect(result.kind).toBe("joined_data");
    expect(getter).not.toHaveBeenCalled();
    if (result.kind === "joined_data")
      disposeNativeOriginalConfigurationSample(result.data.configuration);
  });

  test("invalid UTF8/extra schema fields are refused even with an authentic body MAC", async () => {
    const f = fixture();
    for (const body of [
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ ...f.request, authenticated: true })),
    ])
      expect(await lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.sign(body), body)).toEqual({
        kind: "refused",
      });
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("control/authority refusal remains fenced; DB uncertainty propagates without success", async () => {
    const f = fixture();
    const fenced = {
      rollback() {},
      execute: mock(async () => [{ result: { kind: "fenced" } }]),
    } as unknown as Database;
    expect(await lockNativeLiveDeclarationJoinTx(fenced, f.settings, f.envelope, f.body)).toEqual({
      kind: "fenced",
    });
    const failure = new Error("synthetic lock timeout / rollback uncertainty");
    f.execute.mockImplementation(async () => {
      throw failure;
    });
    await expect(
      lockNativeLiveDeclarationJoinTx(f.tx, f.settings, f.envelope, f.body),
    ).rejects.toBe(failure);
    await expect(
      lockNativeLiveDeclarationJoinTx({} as Database, f.settings, f.envelope, f.body),
    ).rejects.toThrow("existing transaction");
  });
});
